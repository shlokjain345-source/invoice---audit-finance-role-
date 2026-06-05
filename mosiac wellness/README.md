# Invoice Audit Intelligence
### Mosaic Wellness — Automated Vendor Billing Analysis

An automated system that cross-references 21,800+ invoice line items across 15 vendors against contracted rate cards to surface every overcharge, GST error, math discrepancy, and duplicate billing.

---

## What It Does

Fetches data from 3 API endpoints (~270 pages total) and runs 5 audit checks:

| Check | Description |
|-------|-------------|
| **Rate Overcharge** | Vendor billed above contracted unit rate |
| **GST Rate Error** | Applied GST% differs from contracted rate |
| **Math Error** | Qty × unit price ≠ line total |
| **Duplicate Lines** | Same item billed multiple times in one invoice |
| **Unknown Items** | Item not found in rate card |

## Key Features

- **CFO Dashboard** — executive summary with total overcharge amount and vendor breakdown
- **Interactive Flags Table** — filterable, searchable, sortable with 20k+ rows paginated
- **Vendor Risk Matrix** — all 15 vendors ranked by overcharge amount and severity
- **Charts** — bar chart of top offenders + pie breakdown by flag type

---

## Local Development

```bash
npm install
npm run dev
```

## Deploy to Vercel

### Option 1 — Via GitHub (Recommended)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project
3. Import your GitHub repo
4. Click Deploy (Vercel auto-detects Vite)

### Option 2 — Vercel CLI

```bash
npm install -g vercel
vercel
```

No configuration needed — Vite is auto-detected.

---

## Tech Stack

- **React 18** + Vite
- **Recharts** for data visualization
- **Syne + DM Mono** fonts (Google Fonts)
- Zero backend — runs entirely in the browser

---

## Approach & Methodology

Data was fetched from all pages of 3 endpoints:
- `/invoices` — 52 pages, 5,200 rows
- `/line-items` — 218 pages, 21,800 rows  
- `/rate-card` — 2 pages, 105 rows

The audit engine builds a lookup map from the rate card (`vendor_id + item_name` as key), then iterates every line item running all 5 checks. Results are aggregated by vendor for the executive summary.

---

## Key Findings (Preliminary from data sample)

- GST rate errors are the most common flag type (INV-00001 line 1 already shows 28% charged vs 18% contracted)
- Marketing vendors (PixelCraft, CloudNine, DigiBoost, Brandwise) account for the largest absolute overcharges due to high unit values
- Rate overcharges in logistics vendors are smaller per line but high in frequency

---

*Built for the Mosaic Fellowship — Finance Track*
