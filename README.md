# PDF Filler (Netlify/Node)

Netlify-ready Node function that fills the Fertigmeldung PDF from sevDesk order/contact data and returns a PDF download.

## Layout
- `netlify/functions/fill_pdf.js` — Netlify Function (Node, ES modules).
- `fields_template.json` — base mapping with defaults (Check Box12 = /Ja).
- `netlify.toml` — functions dir + CORS headers.
- You must provide the form PDF (default path: `Fertigmeldung_Ihrer_Anlage Vorlage.pdf` in project root or set `FORM_PATH`).

## Install (local test)
```bash
cd node-netlify
npm install
```

## Environment variables (Netlify)
- `API_KEY` (required if you want auth; send in `Authorization` header).
- `SEVDESK_FIXED_TOKEN` (sevDesk token, no Bearer).
- `SEVDESK_DEFAULT_ORDER` (optional default orderNumber).
- `FORM_PATH` (optional, default `Fertigmeldung_Ihrer_Anlage Vorlage.pdf`).

## Deploy to Netlify
- Connect this folder as a site; build command: none; functions dir: `netlify/functions`.
- Set env vars above.
- Deploy; function URL: `/.netlify/functions/fill_pdf`.

## Call example
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: <API_KEY>" \
  -d '{"orderNumber":"AN202506230"}' \
  https://<yoursite>.netlify.app/.netlify/functions/fill_pdf \
  --output Fertigmeldung.pdf
```

## Behavior
- Fetch sevDesk order (multiple endpoints with `embed=positions`), contact, positions, parts (`?embed=category`).
- Map name/address/phone/email -> Text1/2/3/6.
- kWp from `Photovoltaikanlage ... kWp` in positions or order header/addressName.
- Inverter kW/kVA from inverter-like position/part names; uses largest number found.
- Appends today’s date to Text40 and Text7.
- Builds filename `Fertigmeldung_Ihrer_Anlage_<lastname>_Vorlage.pdf`.
- Returns PDF; keeps form fields (not flattened).
