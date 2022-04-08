async function main () {
  const fetch = await import('node-fetch')

  const enDirectResponse = await fetch.default('https://www.francetvinfo.fr/en-direct/')
  const enDirectContent = await enDirectResponse.text()
  // match the live ID
  // "live_id":"4e9efb1a1cc6f04d9800002c"
  const liveId = enDirectContent.match(/live_id":"([^"]+)"/)[1]

  let per_page = 100
  const processedIds = []

  while (true) {
    const liveResponse = await fetch.default(`https://live.francetvinfo.fr/v2/lives/${liveId}/messages?page=1&per_page=${per_page}`)
    const liveJson = await liveResponse.json()
    per_page = 10

    // {"_id":"621e20138256bfb7b8fba9bc","type":"message","live_id":"4e9efb1a1cc6f04d9800002c","body":"\u003cp\u003e\u003cstrong\u003e#UKRAINE L'armée russe dit aux civils de Kiev vivant près d'infrastructures du renseignement ukrainien d'évacuer\u003c/strong\u003e\n\u003c/p\u003e","username":"alerte franceinfo","avatar":{"url":"https://live.francetvinfo.fr/uploads/avatars/5c5c05df8256bf82b985a534.png","icon":{"url":"https://live.francetvinfo.fr/uploads/avatars/icon_5c5c05df8256bf82b985a534.png"},"thumb":{"url":"https://live.francetvinfo.fr/uploads/avatars/thumb_5c5c05df8256bf82b985a534.png"},"big":{"url":"https://live.francetvinfo.fr/uploads/avatars/big_5c5c05df8256bf82b985a534.png"}},"trending_topics":["UKRAINE"],"images":[],"images_credit":"","videos":[],"links":[],"iframes":[],"plain_text":"\u003cp\u003e\u003cstrong\u003e#UKRAINE L'armée russe dit aux civils de Kiev vivant près d'infrastructures du renseignement ukrainien d'évacuer\u003c/strong\u003e\u003c/p\u003e","url":"https://www.francetvinfo.fr/live/message/621/e20/138/256/bfb/7b8/fba/9bc.html","role":"","origin_type":"Item","version":1,"via":"","sticky":false,"created_at":"2022-03-01T14:31:01+01:00","updated_at":"2022-03-01T14:31:01+01:00","ftvi":[]}

    // find messages for the user "alerte franceinfo"
    // and filter them to only keep the ones not already processed
    const messages = liveJson.reverse().filter(message => message.username === 'alerte franceinfo' && !processedIds.includes(message._id))

    for (const message of messages) {
      processedIds.push(message._id)

      // display the message in the console with the formated date in FR
      // remove the HTML tags from the message to display
      const date = new Date(message.created_at)
      const dateString = date.toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
      })
      console.log(`${dateString} - ${message.body.replace(/<[^>]*>/g, '')}`)
    }

    // wait 1 minute before fetching the next request
    await new Promise(resolve => setTimeout(resolve, 60000))
  }
}

main().catch(console.error)
