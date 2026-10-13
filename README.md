# Crydex

An audio-first Pokémon study app for learning every Pokémon cry.

## Run locally

From this folder, start any static web server:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Features

- Real game cries and official-artwork sprite references loaded from PokéAPI
- Decoded cry audio rendered as its actual waveform
- Ten-question, multiple-choice listening sessions
- Generation filters and keyboard shortcuts (`Space` to replay, `1`–`4` to answer)
- Searchable National Pokédex sound library
- Favorites, discoveries, accuracy, and streaks saved in `localStorage`
- Responsive Pokédex-inspired desktop and mobile layouts
- Loading, empty, offline, and audio-error states

## Data

Pokémon metadata and media URLs are retrieved from [PokéAPI](https://pokeapi.co/), a community-maintained API. Pokémon and Pokémon character names are trademarks of Nintendo. Pokémon © Nintendo / Creatures Inc. / GAME FREAK inc.
