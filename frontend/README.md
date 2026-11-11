# Invoice dashboard

React 19 and TypeScript dashboard for uploading invoice PDFs, reviewing extracted fields, and
asking the invoice assistant questions. Built with Vite 8, Tailwind CSS, and shadcn/ui.

See the [project README](../README.md#run-the-dashboard) for Node requirements, installation,
API configuration, and the distinction between the local dashboard and AWS backend.

Run these commands from this directory:

```bash
npm ci
npm run dev
```

The API base URL is the `BASE` constant in [`src/api/client.ts`](src/api/client.ts).
Set it to your own deployment before using the dashboard. There is no API proxy or local
backend in the Vite configuration.

```bash
npm run lint
npm run build
npm run preview
```

`preview` serves the built dashboard after `build`; it still calls the configured AWS API.
