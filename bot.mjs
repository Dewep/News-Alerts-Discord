#!/usr/bin/env zx

// Q&A companion to main.mjs: connects to the Discord gateway (outbound WebSocket,
// no inbound port needed) and answers questions asked by mentioning the bot or by
// replying to one of its news alerts. Answers are researched with Anthropic's
// server-side web_search / web_fetch tools.

import { Client, GatewayIntentBits, Events, Partials } from 'discord.js'
import Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs'

const discordBotAuthorization = $.env.DISCORD_BOT_AUTHORIZATION
const discordChannelId = $.env.DISCORD_CHANNEL_ID

if (!discordBotAuthorization) {
  console.error('DISCORD_BOT_AUTHORIZATION must be set')
  process.exit(1)
}

if (!$.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY must be set')
  process.exit(1)
}

const anthropic = new Anthropic()

// Written by main.mjs (polling service), read here to resolve a Discord message id
// back to the article it announced.
const STATE_FILE = './handled-news.json'
const QUESTIONS_FILE = './answered-questions.json'

const ANSWER_MODEL = $.env.NEWS_ANSWER_MODEL || 'claude-haiku-5-5'
const ANSWER_MAX_TOKENS = Number($.env.NEWS_ANSWER_MAX_TOKENS || 2000)
const MAX_ANSWER_CHARS = 1900 // Discord's limit is 2000, keep a margin
const MAX_HISTORY = 8 // messages kept per conversation (4 exchanges)
const MAX_PARALLEL_ANSWERS = 2

let answered = new Set()
try {
  answered = new Set(JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')))
} catch {
  console.log('No previous answered-questions state, starting fresh')
}

function saveAnswered () {
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify([...answered].slice(-2000)))
}

function findArticleByMessageId (messageId) {
  if (!messageId) {
    return null
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return (state.published || []).find(p => p.discordMessageId === messageId) || null
  } catch {
    return null
  }
}

const ANSWER_SYSTEM = `Tu es l'assistant du canal Discord d'alertes d'actualité suivi par des ingénieurs français. On te mentionne pour te poser une question sur une actualité publiée dans le canal.

Tu reçois, quand il est disponible, le contexte de l'actualité concernée (titre, résumé, source, lien), puis la question.

Règles de réponse :
- Réponds toujours en français, en texte courant.
- Sois bref : une à trois phrases par question posée, pas plus. Va droit au but.
- Pas de titres, pas de sections en gras, pas de rappel de la question, pas de formule de politesse. N'ajoute rien qui n'ait pas été demandé (pas de « pour préciser », pas de contexte supplémentaire en fin de message).
- Tu peux et dois utiliser la recherche web (web_search) et la lecture de pages (web_fetch) pour vérifier les faits et compléter le contexte fourni. Cite tes sources par un lien Markdown directement dans le texte.
- N'invente jamais. Si tu ne trouves pas la réponse, dis-le en une phrase (« je ne trouve pas », « je ne sais pas ») plutôt que de hasarder une réponse fausse.
- Si une information est incertaine ou provient d'une source unique, signale-le en quelques mots (« d'après X », « à confirmer »), sans longue mise en garde.`

function buildContext (article, referencedContent) {
  if (article) {
    const lines = [
      `Titre: ${article.title}`,
      `Source: ${article.source}`,
    ]
    if (article.description) {
      lines.push(`Résumé: ${article.description}`)
    }
    if (article.link) {
      lines.push(`Lien: ${article.link}`)
    }
    return lines.join('\n')
  }

  if (referencedContent) {
    // Fallback when the article context has aged out of handled-news.json:
    // the raw content of the bot message we are replying to.
    return `Message d'alerte (contexte brut):\n${referencedContent}`
  }

  return null
}

async function askClaude (context, question, history) {
  // The article context (and its URL) only needs to be sent on the first turn:
  // later turns already carry it in the conversation history. Keeping the URL in a
  // *user* message (not the system prompt) is also what lets web_fetch read it.
  const content = context && history.length === 0
    ? `Actualité concernée:\n${context}\n\nQuestion: ${question}`
    : question

  const messages = [...history, { role: 'user', content }]

  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await anthropic.messages.create({
      model: ANSWER_MODEL,
      max_tokens: ANSWER_MAX_TOKENS,
      system: ANSWER_SYSTEM,
      // Server-side tools: Anthropic runs the search/fetch loop itself and returns
      // the final answer. `pause_turn` means it needs another round-trip.
      // If the API ever rejects web_fetch with a 400 about a beta header, pass
      // `anthropic-beta: web-fetch-2025-09-10` (headers option) or drop the tool.
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3 },
      ],
      messages,
    })

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content })
      continue
    }

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      // Concatenate without a separator: the API splits the assistant text into
      // several blocks around citation anchors, and joining with '\n' would inject
      // spurious line breaks in the middle of sentences.
      .join('')
      .trim()

    return { text, prompt: content }
  }

  throw new Error('web tools did not settle (pause_turn loop)')
}

function chunkMessage (text, size = MAX_ANSWER_CHARS) {
  const chunks = []
  let rest = text

  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size / 2) {
      cut = rest.lastIndexOf(' ', size)
    }
    if (cut < size / 2) {
      cut = size
    }
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^[\n ]+/, '')
  }

  if (rest) {
    chunks.push(rest)
  }

  return chunks
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
})

// bot answer message id -> root news message id, so a reply to an answer still
// resolves to the article it is about
const answerRoots = new Map()
// root news message id -> prior messages, for follow-up questions in the same chain
const conversations = new Map()

let running = 0
const backlog = []
let queue = Promise.resolve()

client.on(Events.MessageCreate, message => {
  // Serialize event handling so a burst cannot spawn unbounded API calls.
  queue = queue.then(() => enqueue(message)).catch(err => console.error('[handler.error]', err))
})

async function enqueue (message) {
  const trigger = await detectTrigger(message)
  if (!trigger) {
    return
  }

  backlog.push(trigger)
  pump()
}

function pump () {
  while (running < MAX_PARALLEL_ANSWERS && backlog.length > 0) {
    const trigger = backlog.shift()
    running++
    handleQuestion(trigger)
      .catch(err => console.error('[answer.error]', err))
      .finally(() => {
        running--
        pump()
      })
  }
}

async function detectTrigger (message) {
  if (message.author.bot) {
    return null
  }
  if (answered.has(message.id)) {
    return null
  }
  // In guilds, only answer in the configured channel; DMs are always allowed.
  if (discordChannelId && message.guild && message.channelId !== discordChannelId) {
    return null
  }

  // Only a mention triggers an answer. Replying to a bot message does NOT trigger:
  // the channel members debate the news among themselves and the bot should stay out
  // of it. A reply is only used to find which news the question is about.
  if (!client.user || !message.mentions.has(client.user)) {
    return null
  }

  let referenced = null
  if (message.reference?.messageId) {
    try {
      referenced = await message.fetchReference()
    } catch {
      // referenced message deleted or not fetchable
    }
  }

  // Resolve the news article the question is about (if any)
  let article = null
  let rootId = message.id

  if (referenced) {
    article = findArticleByMessageId(referenced.id)
    if (article) {
      rootId = referenced.id
    } else if (answerRoots.has(referenced.id)) {
      rootId = answerRoots.get(referenced.id)
      article = findArticleByMessageId(rootId)
    }
  }

  const question = message.content
    .replace(new RegExp(`<@!?${client.user?.id}>`, 'g'), '')
    .trim()

  return {
    message,
    question,
    article,
    rootId,
    referencedContent: referenced && !article ? referenced.content : null,
  }
}

async function handleQuestion ({ message, question, article, rootId, referencedContent }) {
  answered.add(message.id)
  saveAnswered()

  if (!question) {
    await message.reply({
      content: 'Pose-moi ta question et je cherche la réponse.',
      allowedMentions: { repliedUser: false },
    })
    return
  }

  const context = buildContext(article, referencedContent)
  const history = conversations.get(rootId) || []

  console.log(`Question (${message.id})${article ? ` on ${article.title}` : ''}: ${question}`)

  const channel = message.channel
  await channel.sendTyping().catch(() => {})
  const typing = setInterval(() => channel.sendTyping().catch(() => {}), 8000)

  try {
    const { text, prompt } = await askClaude(context, question, history)

    if (!text) {
      await message.reply({
        content: "Je n'ai pas réussi à formuler de réponse, reformule ta question ?",
        allowedMentions: { repliedUser: false },
      })
      return
    }

    const chunks = chunkMessage(text)
    const first = await message.reply({
      content: chunks[0],
      allowedMentions: { repliedUser: false },
    })
    answerRoots.set(first.id, rootId)

    for (const chunk of chunks.slice(1)) {
      const extra = await channel.send({ content: chunk, allowedMentions: { repliedUser: false } })
      answerRoots.set(extra.id, rootId)
    }

    conversations.set(rootId, [
      ...history,
      { role: 'user', content: prompt },
      { role: 'assistant', content: text },
    ].slice(-MAX_HISTORY))

    console.log(`Answered ${message.id}`)
  } catch (err) {
    console.error('[answer.error]', err)
    await message.reply({
      content: "Désolé, je n'ai pas pu répondre (erreur technique). Réessaie plus tard.",
      allowedMentions: { repliedUser: false },
    }).catch(() => {})
  } finally {
    clearInterval(typing)
  }
}

client.once(Events.ClientReady, c => {
  console.log(`Logged in as ${c.user.tag} (${c.user.id})`)
  if (discordChannelId) {
    console.log(`Answering in channel ${discordChannelId}`)
  }
})

client.login(discordBotAuthorization)
