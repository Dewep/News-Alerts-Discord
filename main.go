package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

func main() {
	discordChannelId := os.Getenv("DISCORD_CHANNEL_ID")
	discordBotAuthorization := os.Getenv("DISCORD_BOT_AUTHORIZATION")

	if discordChannelId == "" || discordBotAuthorization == "" {
		fmt.Println("DISCORD_CHANNEL_ID and DISCORD_BOT_AUTHORIZATION must be set")
		os.Exit(1)
	}

	go afp(discordChannelId, discordBotAuthorization)
	go francetvinfo(discordChannelId, discordBotAuthorization)

	// wait for Goroutines to finish
	select {}
}

func afp(discordChannelId string, discordBotAuthorization string) {
	lastId := ""

	for {
		messages, newLastId, err := getAfpTweets(lastId)
		if err != nil {
			fmt.Println(err)
			time.Sleep(60 * time.Second)
			continue
		}

		if lastId != newLastId {
			lastId = newLastId
			fmt.Println("AFP LastID: " + lastId)
		}
		for _, message := range messages {
			fmt.Println(message)
			sendDiscordMessage(discordChannelId, discordBotAuthorization, message)
			time.Sleep(10 * time.Second)
		}

		time.Sleep(30 * time.Minute)
	}
}

func francetvinfo(discordChannelId string, discordBotAuthorization string) {
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
				time.Sleep(10 * time.Second)
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
	req, err := http.NewRequest("POST", "https://discordapp.com/api/channels/"+discordChannelId+"/messages", body)
	if err != nil {
		return err
	}

	req.Header.Add("Authorization", "Bot "+discordBotAuthorization)
	req.Header.Add("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	return nil
}

func getAfpTweets(lastId string) (messages []string, newLastId string, err error) {
	gqlData := bytes.NewBuffer([]byte("{\"operationName\":\"feed\",\"variables\":{\"id\":\"NlVXc2tnSvbQDAcv\"},\"query\":\"query feed($id: ID\u0021, $after: Int, $isPreview: Boolean) {\\n  feed(id: $id, after: $after, isPreview: $isPreview) {\\n    ...Feed\\n    __typename\\n  }\\n}\\n\\nfragment Feed on Feed {\\n  id\\n  items {\\n    ...FeedItem\\n    __typename\\n  }\\n  __typename\\n}\\n\\nfragment FeedItem on FeedItem {\\n  id\\n  title\\n  url\\n  date\\n  __typename\\n}\\n\"}"))

	client := http.Client{}
	req, err := http.NewRequest("POST", "https://rss.app/gql", gqlData)
	if err != nil {
		return nil, lastId, err
	}

	req.Header.Add("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, lastId, err
	}
	defer resp.Body.Close()

	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, lastId, err
	}

	var jsonContent interface{}
	err = json.Unmarshal(body, &jsonContent)
	// {"data":{"feed":{"id":"NlVXc2tnSvbQDAcv","items":[{"id":"rGRdzyoaVSxCujvQ","title":"💬 \"C'est beau hein ? Mais regarde sous tes pieds\" \n\nDans les Cornouailles, l'invasion silencieuse des microbilles de plastique #AFP \n➡️ https://t.co/Ng1J2xYBxa https://t.co/qTyYejS0bB","url":"https://twitter.com/afpfr/status/1645864292489764865","date":"2023-04-11T19:00:00.000Z","__typename":"FeedItem"},{"id":"HhxJEKjTOxkP9ZwR","title":"🇬🇧 Le @DesignMuseum de Londres inaugure l'exposition de Ai Weiwei, artiste dissident chinois, qui présente des installations monumentales mêlant la politique au personnel ⤵️ \n🎥 @JustineGerardy #AFP https://t.co/7apwOj8krv","url":"https://twitter.com/afpfr/status/1645849191808155649","date":"2023-04-11T18:00:00.000Z","__typename":"FeedItem"},{"id":"d6XhUtgUzN4ikPO7","title":"🇺🇦 Comme chaque matin, Valentin Doudkine, 80 ans, assemble son trombone dans un quartier de Kiev et commence à faire sonner l'hymne ukrainien: \"L'Ukraine n'est pas encore morte\" ⤵️ #AFP https://t.co/16X46D62hn","url":"https://twitter.com/afpfr/status/1645834103726407680","date":"2023-04-11T17:00:03.000Z","__typename":"FeedItem"}],"__typename":"Feed"}}}
	if err != nil {
		return nil, lastId, err
	}

	root := jsonContent.(map[string]interface{})
	data := root["data"].(map[string]interface{})
	feed := data["feed"].(map[string]interface{})
	items := feed["items"].([]interface{})

	alreadyRead := lastId != ""

	for i := len(items) - 1; i >= 0; i-- {
		item := items[i].(map[string]interface{})
		id := item["id"].(string)
		title := item["title"].(string)

		if id == lastId {
			alreadyRead = false
			continue
		}
		if alreadyRead {
			continue
		}
		lastId = id

		prefixRegex := regexp.MustCompile(`^.*\[[A|À]?\s?LA UNE [A|À]?\s?\w+\]\n?\s?\s?`)
		if prefixRegex.MatchString(title) {
			// Remove prefix
			title = prefixRegex.ReplaceAllString(title, "")

			// Remove suffix with "{integer}/{integer}"
			suffixRegex := regexp.MustCompile(`(\s#AFP)?(\s\d+\/\d+)?(\shttps:\/\/.+)?\s?$`)
			title = suffixRegex.ReplaceAllString(title, "")

			message := "> " + strings.ReplaceAll(title, "\n", " ")
			messages = append(messages, message)
		}
	}

	return messages, lastId, nil
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

func getLiveId() (liveId string, err error) {
	liveIdRegex, _ := regexp.Compile("/live/iframe/([^\"]+)\"")

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
