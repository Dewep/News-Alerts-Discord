#!/usr/bin/env zx

import { JSDOM } from 'jsdom'
import Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs'

const dryRun = argv['dry-run']

const discordChannelId = $.env.DISCORD_CHANNEL_ID || '1191659330869678120'
const discordBotAuthorization = $.env.DISCORD_BOT_AUTHORIZATION

if (!$.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY must be set')
  process.exit(1)
}

if (!dryRun && (!discordChannelId || !discordBotAuthorization)) {
  console.error('DISCORD_CHANNEL_ID and DISCORD_BOT_AUTHORIZATION must be set')
  process.exit(1)
}

const anthropic = new Anthropic()

const STATE_FILE = './handled-news.json'
const HANDLED_MAX = 5000
const PUBLISHED_RETENTION_MS = 48 * 60 * 60 * 1000

let state = { handledIds: [], published: [] }
try {
  const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (Array.isArray(loaded)) {
    // Legacy format: a plain array of handled IDs
    state.handledIds = loaded
  } else {
    state = { ...state, ...loaded }
  }
} catch {
  console.log('No previous state, starting fresh')
}

function saveState () {
  state.handledIds = state.handledIds.slice(-HANDLED_MAX)
  state.published = state.published.filter(p => Date.now() - new Date(p.at).getTime() < PUBLISHED_RETENTION_MS)
  fs.writeFileSync(STATE_FILE, JSON.stringify(state))
}

async function sendDiscordMessage (message) {
  await fetch(`https://discordapp.com/api/channels/${discordChannelId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bot ${discordBotAuthorization}`,
    },
    body: JSON.stringify({ content: message })
  })
}

function buildMessage (article) {
  const parts = [article.description, '#' + article.source, `(${article.decision.importance}/10)`].filter(Boolean).join(' ')
  return `> **${article.title}**\n> *${parts}*`
}

function stripHtml (text) {
  if (!text) {
    return ''
  }
  const fragment = JSDOM.fragment(`<div>${text}</div>`)
  return fragment.textContent.replace(/\s+/g, ' ').trim()
}

async function fetchRSS ({ source, url, maxItems = 30 }) {
  const articles = []

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
      'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    },
  })
  const content = await response.text()

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${content.slice(0, 200).replace(/\s+/g, ' ')}`)
  }

  let dom
  try {
    dom = new JSDOM(content, { contentType: 'text/xml' })
  } catch {
    throw new Error(`Invalid XML from ${url} (HTTP ${response.status}), body starts with: ${content.slice(0, 200).replace(/\s+/g, ' ')}`)
  }
  const items = dom.window.document.querySelectorAll('channel > item')

  for (const item of items) {
    if (articles.length >= maxItems) {
      break
    }

    const id = item.querySelector('guid')?.textContent || item.querySelector('link')?.textContent
    const title = stripHtml(item.querySelector('title')?.textContent)
    const description = stripHtml(item.querySelector('description')?.textContent)
    const pubDate = Date.parse(item.querySelector('pubDate')?.textContent || '')

    if (!id || !title) {
      continue
    }

    articles.push({ id, source, title, description, date: Number.isNaN(pubDate) ? null : pubDate })
  }

  return articles
}

const providers = [
  // Le Figaro Flash Actu (https://www.lefigaro.fr/rss/figaro_flash-actu.xml) would be a
  // richer general wire, but lefigaro.fr sits behind Datadome which serves a bot-challenge
  // page to datacenter IPs instead of the feed
  { name: 'FranceInfo', fetch: () => fetchRSS({ source: 'FranceInfo', url: 'https://www.franceinfo.fr/titres.rss' }) },
  { name: 'LeMondePixels', fetch: () => fetchRSS({ source: 'LeMondePixels', url: 'https://www.lemonde.fr/pixels/rss_full.xml' }) },
]

// Articles older than this are ignored: bounds the backlog processed on a
// fresh start (no state file) or after a long downtime
const MAX_AGE_MS = 12 * 60 * 60 * 1000

const FILTER_MODEL = 'claude-haiku-4-5'
const FILTER_THRESHOLD = Number($.env.NEWS_IMPORTANCE_THRESHOLD || 6)

const FILTER_SYSTEM = `Tu es le filtre éditorial d'un canal Discord d'alertes d'actualité, suivi par des ingénieurs français (infrastructure, réseau, logiciel). Le canal couvre à la fois l'actualité générale importante (politique, économie, international) ET la tech : ne pénalise jamais une dépêche parce que son sujet n'est pas technique — une décision politique ou économique majeure mérite son score plein.

Tu reçois un lot de dépêches (source, titre, description). Pour chacune, rédige d'abord ta justification (reason), puis attribue un score d'importance de 0 à 10 (importance) strictement cohérent avec ta justification : si ta justification conclut à un plafond, le score doit le respecter. Seules les dépêches les plus importantes seront publiées, avec un objectif de quelques publications par jour seulement : sois exigeant, sur un lot typique la grande majorité des dépêches méritent moins de 7.

Barème :
- 9-10 : événement exceptionnel — attentat majeur, déclaration de guerre, catastrophe de grande ampleur, démission d'un chef d'État, crise financière mondiale
- 7-8 : information importante du jour — décision politique/économique/réglementaire à fort impact, escalade notable d'un conflit, cyberattaque ou sanction cyber d'ampleur étatique, faille de sécurité critique, annonce ou régulation tech qui change la donne (UE, grandes plateformes, IA)
- 5-6 : notable mais pas essentiel — suite sans développement majeur d'un événement déjà publié sur le canal (voir dejaPubliees), annonce d'entreprise ordinaire, rumeur de produit, levée de fonds, débat politique en cours sans décision
- 0-4 : le reste — sport, people, culture, divertissement, faits divers, météo, formats magazine (tests, portraits, séries, tribunes, interviews, récapitulatifs, "on a testé"), teasers sans contenu

Règles supplémentaires :
- L'information doit être complète et compréhensible avec le titre et la description seuls ; sinon, plafonne à 4
- Le sport plafonne à 4 sauf événement d'ampleur nationale exceptionnelle
- Les sujets tech/numérique à impact (cybersécurité, infrastructure, cloud, IA, régulation) sont prioritaires : à importance réelle égale, score +1
- Si plusieurs dépêches du lot couvrent le même événement, seule la plus complète garde son score ; plafonne les autres à 4
- Le message inclut aussi "dejaPubliees" : les titres déjà publiés sur le canal ces dernières 48 heures. Si une dépêche couvre un événement déjà publié, plafonne-la à 4 — sauf développement nouveau et majeur (escalade importante, bilan revu d'un ordre de grandeur, décision finale rendue)`

const DECISIONS_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        // reason comes before importance so the score is generated after the reasoning
        properties: {
          index: { type: 'integer' },
          reason: { type: 'string' },
          importance: { type: 'integer' }
        },
        required: ['index', 'reason', 'importance'],
        additionalProperties: false
      }
    }
  },
  required: ['decisions'],
  additionalProperties: false
}

async function filterArticles (articles) {
  const payload = {
    dejaPubliees: state.published.map(p => p.title),
    depeches: articles.map((article, index) => ({
      index,
      source: article.source,
      title: article.title,
      description: article.description,
    })),
  }

  const response = await anthropic.messages.create({
    model: FILTER_MODEL,
    max_tokens: 16000,
    system: FILTER_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: DECISIONS_SCHEMA } },
    messages: [{ role: 'user', content: JSON.stringify(payload) }]
  })

  if (response.stop_reason !== 'end_turn') {
    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`)
  }

  const text = response.content.find(block => block.type === 'text').text
  const decisions = new Map(JSON.parse(text).decisions.map(d => [d.index, d]))

  return articles.map((article, index) => {
    const decision = decisions.get(index) || { importance: 0, reason: 'non évalué par le filtre' }
    return { ...article, decision: { ...decision, keep: decision.importance >= FILTER_THRESHOLD } }
  })
}

async function checkNewNews () {
  const articles = []

  for (const provider of providers) {
    try {
      articles.push(...await provider.fetch())
    } catch (err) {
      console.warn(`[${provider.name}.error]`, err)
    }
  }

  const seen = new Set()
  const fresh = articles.filter(article => {
    if (article.date && Date.now() - article.date > MAX_AGE_MS) {
      return false
    }
    if (state.handledIds.includes(article.id) || seen.has(article.id)) {
      return false
    }
    seen.add(article.id)
    return true
  })

  if (fresh.length === 0) {
    return
  }

  console.log(`Filtering ${fresh.length} new articles`)

  let evaluated
  try {
    evaluated = await filterArticles(fresh)
  } catch (err) {
    // Articles stay unmarked so they are retried on the next cycle
    console.warn('[filter.error]', err)
    return
  }

  for (const article of evaluated) {
    if (article.decision.keep) {
      if (dryRun) {
        console.log(`[KEEP ${article.decision.importance}] ${buildMessage(article)}\n       → ${article.decision.reason}`)
      } else {
        await sendDiscordMessage(buildMessage(article))
        await sleep(1000)
        console.log('Send', article.id)
      }
      state.published.push({ title: article.title, source: article.source, at: new Date().toISOString() })
    } else if (dryRun) {
      console.log(`[skip ${article.decision.importance}] (${article.source}) ${article.title}\n       → ${article.decision.reason}`)
    }
    state.handledIds.push(article.id)
  }

  if (!dryRun) {
    saveState()
  }
}

if (dryRun) {
  await checkNewNews()
} else {
  while (true) {
    await checkNewNews()

    await sleep(15 * 60 * 1000)
  }
}
