package main

import (
  "fmt"
  "net/http"
  "io/ioutil"
  "regexp"
  "encoding/json"
  "time"
  "bytes"
  "os"
)

func main() {
  discordChannelId := os.Getenv("DISCORD_CHANNEL_ID")
  discordBotAuthorization := os.Getenv("DISCORD_BOT_AUTHORIZATION")

  if discordChannelId == "" || discordBotAuthorization == "" {
    fmt.Println("DISCORD_CHANNEL_ID and DISCORD_BOT_AUTHORIZATION must be set")
    os.Exit(1)
  }

  fmt.Println("FranceTV info, direct alerts:")

  ignoreMessagesIds := []string{}

  for {
    liveId, err := getLiveId()
    if err != nil {
      fmt.Println(err)
      time.Sleep(60 * time.Second)
      continue
    }

    fmt.Println("LiveID:", liveId)

    for i := 0; i < 60; i++ {
      newIgnoreMessagesIds, messages, err := getMessages(liveId, ignoreMessagesIds)
      ignoreMessagesIds = newIgnoreMessagesIds
      if err != nil {
        fmt.Println(err)
        time.Sleep(60 * time.Second)
        continue
      }

      for _, message := range messages {
        fmt.Println(message)
        sendDiscordMessage(discordChannelId, discordBotAuthorization, message)
      }

      time.Sleep(60 * time.Second)
    }
  }
}

func sendDiscordMessage(discordChannelId string, discordBotAuthorization string, message string) (err error) {
  var discordMessage struct {
    Content string `json:"content"`
  }
  discordMessage.Content = message

  json, err := json.Marshal(discordMessage)
  if err != nil {
    return err
  }
  body := bytes.NewBuffer([]byte(json))
  
  client := http.Client{}
  req, err := http.NewRequest("POST", "https://discordapp.com/api/channels/" + discordChannelId + "/messages", body)
  if err != nil {
    return err
  }

  req.Header.Add("Authorization", "Bot " + discordBotAuthorization)
  req.Header.Add("Content-Type", "application/json")
  resp, err := client.Do(req)
  if err != nil {
    return err
  }
  defer resp.Body.Close()

  return nil
}

func getMessages(liveId string, ignoreMessagesIds []string) ([]string, []string, error) {
  url := fmt.Sprintf("https://live.francetvinfo.fr/v2/lives/%s/messages?page=1&per_page=10", liveId)

  resp, err := http.Get(url)
  if err != nil {
    return nil, nil, err
  }
  defer resp.Body.Close()

  body, err := ioutil.ReadAll(resp.Body)
  if err != nil {
    return nil, nil, err
  }

  var jsonContent interface{}
  err = json.Unmarshal(body, &jsonContent)
  // {"_id":"621e20138256bfb7b8fba9bc","type":"message","live_id":"4e9efb1a1cc6f04d9800002c","body":"\u003cp\u003e\u003cstrong\u003e#UKRAINE L'armée russe dit aux civils de Kiev vivant près d'infrastructures du renseignement ukrainien d'évacuer\u003c/strong\u003e\n\u003c/p\u003e","username":"alerte franceinfo","avatar":{"url":"https://live.francetvinfo.fr/uploads/avatars/5c5c05df8256bf82b985a534.png","icon":{"url":"https://live.francetvinfo.fr/uploads/avatars/icon_5c5c05df8256bf82b985a534.png"},"thumb":{"url":"https://live.francetvinfo.fr/uploads/avatars/thumb_5c5c05df8256bf82b985a534.png"},"big":{"url":"https://live.francetvinfo.fr/uploads/avatars/big_5c5c05df8256bf82b985a534.png"}},"trending_topics":["UKRAINE"],"images":[],"images_credit":"","videos":[],"links":[],"iframes":[],"plain_text":"\u003cp\u003e\u003cstrong\u003e#UKRAINE L'armée russe dit aux civils de Kiev vivant près d'infrastructures du renseignement ukrainien d'évacuer\u003c/strong\u003e\u003c/p\u003e","url":"https://www.francetvinfo.fr/live/message/621/e20/138/256/bfb/7b8/fba/9bc.html","role":"","origin_type":"Item","version":1,"via":"","sticky":false,"created_at":"2022-03-01T14:31:01+01:00","updated_at":"2022-03-01T14:31:01+01:00","ftvi":[]}
  if err != nil {
    return nil, nil, err
  }

  jsonContentArray := jsonContent.([]interface{})
  ids := []string{}
  messages := []string{}

  for i := len(jsonContentArray) - 1; i >= 0; i-- {
    message := jsonContentArray[i].(map[string]interface{})

    if message["username"] != "alerte franceinfo" {
      continue
    }
      
    ids = append(ids, message["_id"].(string))

    if ignoreMessagesIds != nil && isInArray(message["_id"].(string), ignoreMessagesIds) {
      continue
    }

    content := regexp.MustCompile("<[^>]*>|\n").ReplaceAllString(message["body"].(string), "")
    messages = append(messages, content)
  }

  return ids, messages, nil
}

func getLiveId() (liveId string, err error){
  liveIdRegex, _ := regexp.Compile("live_id\":\"([^\"]+)\"")

  resp, err := http.Get("https://www.francetvinfo.fr/en-direct/")
  if err != nil {
    return "", err
  }
  defer resp.Body.Close()

  body, err := ioutil.ReadAll(resp.Body)
  if err != nil {
    return "", err
  }

  match := liveIdRegex.FindStringSubmatch(string(body))
  if len(match) != 2 {
    return "", fmt.Errorf("No match")
  }

  return match[1], nil
}

func isInArray(needle string, haystack []string) bool {
  for _, hay := range haystack {
    if needle == hay {
      return true
    }
  }
  return false
}
