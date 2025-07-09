#!/usr/bin/env zx

import { JSDOM } from 'jsdom'

const discordChannelId = $.env.DISCORD_CHANNEL_ID || '1191659330869678120'
const discordBotAuthorization = $.env.DISCORD_BOT_AUTHORIZATION

if (!discordChannelId || !discordBotAuthorization) {
  console.error('DISCORD_CHANNEL_ID and DISCORD_BOT_AUTHORIZATION must be set')
  process.exit(1)
}

const newsAlreadyHandled = []

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

async function fetchLeMonde () {
  const articles = []

  const resonse = await fetch('https://www.lemonde.fr/actualite-en-continu/')
  const content = await resonse.text()

  const dom = new JSDOM(content)

  const teasers = dom.window.document.querySelectorAll('#river > .teaser')
  for (const teaser of teasers) {
    if (teaser.querySelector('.icon__label-alert') && !teaser.querySelector('.teaser__kicker--premium')) {
      const id = teaser.querySelector('.teaser__link').getAttribute('href')
      const title = teaser.querySelector('.teaser__title').textContent
      const description = teaser.querySelector('.teaser__desc').textContent

      const message = `> **${title}**\n> *${description} #LeMonde*`
      articles.push({ id, message })
    }
  }

  return articles
}

async function fetchFranceInfo () {
  const articles = []

  const response = await fetch('https://www.francetvinfo.fr/en-direct/')
  const content = await response.text()

  const dom = new JSDOM(content)
  const nextDataDom = dom.window.document.getElementById('__NEXT_DATA__')
  const nextData = JSON.parse(nextDataDom.textContent)

  for (const publication of nextData.props.pageProps.tl.publications) {
    if (publication.author.name === 'alerte franceinfo') {
      const id = 'FranceInfo:' + publication._id
      const title = publication.message.content[0].content.map(c => c.text).join(' ')

      const message = `> **${title}** *#FranceInfo*`
      articles.push({ id, message })
    }
  }

  return articles
}

async function fetchBFMTV () {
  const articles = []

  const response = await fetch('https://www.bfmtv.com/')
  const content = await response.text()

  const dom = new JSDOM(content)
  const items = dom.window.document.querySelectorAll('.list_news > .content_item.content_item_flash > a')

  for (const item of items) {
    const id = item.getAttribute('href')
    const title = item.querySelector('.content_item_title').textContent
    const description = item.querySelector('.item_chapo').textContent

    const message = `> **${title}**\n> *${description} #BFMTV*`
    articles.push({ id, message })
  }

  return articles
}

async function fetchNouvelObs () {
  const articles = []

  const response = await fetch('https://www.nouvelobs.com/depeche/atom.xml')
  const content = await response.text()

  const dom = new JSDOM(content, { contentType: 'text/xml' })
  const items = dom.window.document.querySelectorAll('feed > entry')

  let counter = 0
  for (const item of items) {
    // Do not try to load oldest articles
    if (counter++ > 10) {
      break
    }

    const hasAuthor = !!item.querySelector('author')
    if (hasAuthor) {
      continue
    }

    const id = item.querySelector('id').textContent
    const title = item.querySelector('title').textContent
    const description = item.querySelector('summary').textContent
    const tags = Array.from(item.querySelectorAll('category'))
      .map(c => c.getAttribute('term'))
      .filter(c => c && c !== 'article_news')
      .map(c => '#' + c)
      .join(' ')

    const message = `> **${title}**\n> *${description} ${tags} #NouvelObs*`
    articles.push({ id, message })
  }

  return articles
}

async function checkNewNews() {
  const articles = []

  /*try {
    const franceInfo = await fetchFranceInfo()
    articles.push(...franceInfo)
  } catch (err) {
    console.warn('[FranceInfo.error]', err)
  }*/

  try {
    const leMonde = await fetchLeMonde()
    articles.push(...leMonde)
  } catch (err) {
    console.warn('[LeMonde.error]', err)
  }

  try {
    const BFMTV = await fetchBFMTV()
    articles.push(...BFMTV)
  } catch (err) {
    console.warn('[BFMTV.error]', err)
  }

  try {
    const NouvelObs = await fetchNouvelObs()
    articles.push(...NouvelObs)
  } catch (err) {
    console.warn('[NouvelObs.error]', err)
  }

  for (const article of articles) {
    if (!newsAlreadyHandled.includes(article.id)) {
      await sendDiscordMessage(article.message)
      newsAlreadyHandled.push(article.id)
    }
  }
}

while (true) {
  await checkNewNews()

  await sleep(15 * 60 * 1000)
}
