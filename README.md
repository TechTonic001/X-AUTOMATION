# X Thread Studio

A local Node.js app that generates technical X drafts, avoids repeating a topic within 14 days, and saves every draft in PostgreSQL for manual scheduling.

## Setup

1. Create a PostgreSQL database and run `schema.sql` against it.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` and `GEMINI_API_KEY`.
3. Install dependencies with `npm install`.
4. Start the app with `npm start` and open `http://localhost:3000`.

The `GEMINI_MODEL` value defaults to `gemini-3.7-flash` and can be changed in `.env` if the model is unavailable for your account. Use the Generate button to create a draft. The API key is never sent to the browser.
