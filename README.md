This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Port data APIs

- `GET /api/weather` returns a two-day hourly Open-Meteo weather and marine forecast for the Port of Los Angeles.
- `GET /api/ships` is a Server-Sent Events stream. Listen for `vessel` events with `EventSource`; each event contains an AISStream `PositionReport` message for the San Pedro Bay area.

Set `AISSTREAM_API_KEY` in `.env.local` (copy `.env.example`) before using the ships endpoint. Keep this key server-side; the route does not expose it to the browser. The ships route uses the server's built-in WebSocket, so run it on Node.js 22 or later. The API check script requires Node.js 22.6 or later. Open-Meteo does not require a key.

```js
const forecast = await fetch("/api/weather").then((response) => response.json());
const ships = new EventSource("/api/ships");
ships.addEventListener("vessel", (event) => {
  const aisMessage = JSON.parse(event.data);
  // Use aisMessage.MetaData and aisMessage.Message.PositionReport in the harness.
});
```

Run the API route checks with `npm run test:api`.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
