# ai-knowledge-base
Building a system where a user can upload multiple documents, search them in natural language, get AI-generated answers

## Tech Stack
- Next.js
- AI SDK
- Google Gemini
- PostgreSQL
- Vercel Blob

## Features
- Upload multiple documents
- Search them in natural language
- Get AI-generated answers

## How to run
- Clone the repository
- Install dependencies - npm i
- Set up environment variables
- Run the development server - npm run dev
- Open http://localhost:3000 in your browser

## Environment variables
- GOOGLE_GENERATIVE_AI_API_KEY
- AUTH_SECRET
- BLOB_READ_WRITE_TOKEN
- POSTGRES_URL

## Design Decisions
- Used AI SDK to handle the AI part
- Used PostgreSQL to store the documents
- Used Vercel Blob to store the documents
- Used Next.js to build the UI
- Used Google Gemini for AI

## Trade-offs made due to the 24h constraint.
- There are a few bugs which I am not able to fix currently due to time constraints. -The chat history is not loading, but it is getting stored in the database.
- Moreover, there is a bug, where I am getting error when I send a follow-up message in the same chat. 
