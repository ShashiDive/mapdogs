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
| `vercel.json` | Hosting settings |
| `database/01_setup.sql` | Run once in Supabase to create the database |

No build step: Vercel serves these files as they are.

## Safety

- `config.js` holds only the **publishable** key, which is designed to be public.
  Never put the **secret** key anywhere in this repository.
- Photos are private in Supabase Storage. A parent screens every submission before
  anyone else can see it.
