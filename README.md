# Coach Kiro Publisher

Small web app to publish your own videos to your own TikTok account (Login Kit + Content Posting API, Direct Post, FILE_UPLOAD).

## Environment variables

| Name | Value |
| --- | --- |
| `TIKTOK_CLIENT_KEY` | Client key from the TikTok developer portal |
| `TIKTOK_CLIENT_SECRET` | Client secret from the TikTok developer portal |
| `BASE_URL` | Public address of the app, no trailing slash (e.g. `https://coachkiro-publisher.onrender.com`) |

## Deploy on Render

1. Push this folder to a GitHub repository.
2. On render.com: New > Web Service > pick the repository.
3. Build command: `npm install` — Start command: `npm start` — Instance: Free.
4. Add the three environment variables above.
5. In TikTok, set the Redirect URI to `BASE_URL/auth/callback`.

## Run locally

```
cp .env.example .env   # then fill it in
npm install
export $(grep -v '^#' .env | xargs) && npm start
```
