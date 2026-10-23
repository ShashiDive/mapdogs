# Mapdogs

A mobile website for photographing Pune's street dogs, so each dog gets its own ID
(PUN-0001, PUN-0002, ...) and volunteers can track which dogs are sterilised,
vaccinated or need help. A school project, Phase 1.

## What's here

| File | What it does |
| --- | --- |
| `index.html` | The page shell |
| `app.js` | Every screen of the contributor flow |
| `strings.js` | All the words on screen, ready for Marathi and Hindi |
| `photo.js` | Resizes photos, reads photo GPS, gets live location |
| `api.js` | Talks to Supabase |
| `styles.css` | Look and layout |
| `config.js` | Your Supabase Project URL and publishable key |
| `admin.html`, `admin.js` | Admin pages for the Screener and Reviewer, at `/admin` |
| `zip.js` | Builds the export ZIP file |
| `vercel.json` | Hosting settings |
| `database/01_setup.sql` | Run once in Supabase to create the database |
| `database/02_map.sql` | Run once in Supabase to add the public map and leaderboard |
| `database/03_admin.sql` | Run once in Supabase to add the admin pages |
| `database/04_details.sql` | Run once in Supabase to add sighting details in My contributions |

The site's address is https://www.mapdogs.in. `mapdogs.in` and the old `mapdogs.vercel.app` both redirect to it.

The public map can be shared directly with a link ending in `#map`.

No build step: Vercel serves these files as they are.

## Safety

- `config.js` holds only the **publishable** key, which is designed to be public.
  Never put the **secret** key anywhere in this repository.
- Photos are private in Supabase Storage. A parent screens every submission before
  anyone else can see it.
