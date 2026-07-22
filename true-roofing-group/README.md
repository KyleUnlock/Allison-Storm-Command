# True Roofing Group — Website

Marketing website + lead-capture landing page for **True Roofing Group**
(owner: **Kris Juric**). Framework-free static site — pure HTML/CSS/JS, no build
step, no dependencies. Deploys anywhere that serves static files (Vercel,
Netlify, Cloudflare Pages, S3, or a plain web host).

Structure and stack mirror the proven **Allison Storm Command** roofing funnel
(navy/accent palette, single-stylesheet, framework-free, Vercel-ready) used as
the reference resource.

## Pages

| File            | Purpose                                                          |
|-----------------|------------------------------------------------------------------|
| `index.html`    | Landing page — hero, services, why-us, process, stats, reviews, CTA |
| `services.html` | Detailed services (replacement, repair, storm, commercial, gutters) |
| `about.html`    | Company story + owner (Kris Juric) + values                      |
| `gallery.html`  | Project gallery (placeholder tiles → real photos)                |
| `contact.html`  | Free-inspection quote form + contact details                     |
| `styles.css`    | Full design system (one file, shared)                            |
| `main.js`       | Mobile nav + client-side form handling                           |

## Run locally

No tooling required — open `index.html` in a browser, or serve the folder:

```bash
cd true-roofing-group
python3 -m http.server 4020    # http://localhost:4020
```

## Deploy (Vercel)

From this folder: `vercel` (or point a Vercel/Netlify project at
`true-roofing-group/` as the root). `vercel.json` is included and serves the
static files as-is.

## Before you launch — replace the placeholders

This site is intentionally content-complete but data-neutral. Swap these in:

1. **Contact info** — phone `(000) 000-0000` and `hello@trueroofinggroup.com`
   appear in every page footer + `contact.html`. Search/replace both.
2. **Service area / city** — copy is written region-neutral. Add your city/metro
   to the hero and footer if you want local SEO.
3. **Reviews** — testimonials are clearly labeled *Sample*. Replace with real
   Google/Facebook reviews (keep names only with the reviewer's permission).
4. **Gallery photos** — `gallery.html` uses gradient placeholder tiles. Replace
   each `.tile` background with a real before/after job photo
   (`background-image: url('assets/your-photo.jpg')`).
5. **Form backend** — `main.js` has a `FORM_ENDPOINT` constant (empty by
   default → shows a success message for demos). Point it at a real handler
   (a Vercel function like Allison's `/api/leads`, Formspree, or a CRM webhook)
   before collecting live leads.
6. **Stats** — `2,000+ roofs`, `15+ years`, etc. are illustrative. Update to
   True Roofing Group's real numbers.
7. **License #** — add the contractor license number to the footer where
   required by your state.

## Compliance note

The contact form includes an explicit contact-consent checkbox (TCPA-style
language) and a "consent is not a condition of purchase" line. If you enable
SMS, confirm the language with your provider/counsel and add a working
opt-out (STOP/HELP) flow, mirroring the discipline in the Allison funnel.
