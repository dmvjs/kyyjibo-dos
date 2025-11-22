# Kwyjibo v2 🎵

> Hamiltonian DJ Player - Infinite AI-powered mixing

**Kwyjibo** is an intelligent DJ player that continuously mixes songs using a Hamiltonian path algorithm. It plays two tracks simultaneously (A/B channels) and seamlessly transitions between song pairs, creating an endless mix that never repeats the same combination twice.

## What is a Hamiltonian DJ Player?

A Hamiltonian path visits every node in a graph exactly once. In Kwyjibo, each song is a node, and the player finds a path through your entire music library, playing songs in pairs that create perfect continuous mixes. You get:

- **Infinite playback** - Never hear the same song pairing twice until you've exhausted all combinations
- **Seamless transitions** - Songs fade in/out with intro and main sections
- **Key/tempo control** - Change the musical key (1-12) and tempo (BPM) on the fly
- **Crossfader mixing** - Blend between A and B tracks in real-time

## Features

- 🎚️ **Crossfader Control** - Mix between track A and track B
- 🎹 **Key Transposition** - Change musical key across 12 positions
- 🥁 **BPM Control** - Adjust tempo with predefined BPM options
- 🔄 **Smart Transitions** - Automatic intro/main section playback
- ⏭️ **Skip Forward/Back** - Navigate through the Hamiltonian path
- 📱 **Wake Lock** - Keeps screen awake during performance
- 🎛️ **Real-time Controls** - All changes apply instantly without interruption

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## How It Works

### 1. Song Data Structure

Each song has:
- **ID** - Unique identifier
- **Title & Artist** - Metadata
- **Lead & Body tracks** - Two MP3 files for each song
- **Key & Tempo** - Musical properties
- **Duration** - Track lengths

### 2. Hamiltonian Path Algorithm

The `HamiltonianPlayer` builds a graph of all songs and finds a Hamiltonian path through them. Each step in the path is a pair of songs (track A and track B) that play simultaneously.

### 3. Playback Engine

- Loads and decodes audio files using Web Audio API
- Manages two audio channels (A/B) with independent gain nodes
- Handles crossfader position for smooth mixing
- Transitions between intro and main sections automatically

### 4. Real-time Controls

All controls update immediately:
- **Crossfader** - Adjusts gain for A/B channels
- **Key** - Re-pitches audio using playback rate
- **Tempo** - Time-stretches audio (changes duration and pitch)
- **Skip** - Loads next/previous song pair in the path

## Project Structure

```
src/
├── music/
│   ├── types.ts              # Key, Tempo, Song interfaces
│   ├── songdata.ts           # Song database (379 songs)
│   └── HamiltonianGraph.ts   # Path-finding algorithm
demo/
├── player/
│   └── HamiltonianPlayer.ts  # Main playback engine
├── App.tsx                    # React UI component
└── styles.css                # UI styling
music/
└── *.mp3                      # Audio files (lead/body tracks)
```

## Usage

### Basic Controls

- **Play/Pause** - Start or pause playback
- **Stop** - Stop and reset to beginning
- **Skip Forward** - Jump to next song pair in the path
- **Skip Back** - Return to previous song pair

### Mixing Controls

- **Crossfader** - Drag slider to mix between track A (left) and track B (right)
- **Key Strip** - Click a key to transpose all audio
- **BPM Strip** - Click a tempo to change playback speed

### Status Display

- Current key and BPM shown in status bar
- "Intro" or "Main" indicator shows current section
- "Now Playing" shows current track A and track B
- "Up Next" shows the next song pair in the path

## Technical Details

### Audio Processing

- Uses Web Audio API `AudioContext` for playback
- Implements gain nodes for crossfader control
- Pitch shifting via `playbackRate` property
- Dual-buffer system for seamless transitions

### State Management

- Event-driven architecture with custom `EventEmitter`
- Player state includes: playing status, current key, current tempo, track pairs
- React hooks for UI updates

### Graph Algorithm

- Builds adjacency matrix from song compatibility
- Uses backtracking to find Hamiltonian path
- Ensures every song pair is unique in the sequence

## Browser Support

Requires modern browser with:
- Web Audio API
- ES6+ JavaScript
- Wake Lock API (optional, for screen wake)

Tested on:
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

## Song Library

Currently includes **379 songs** with both lead and body tracks (758 total MP3 files). Songs span various keys and tempos for maximum mixing compatibility.

## Development

Built with:
- **TypeScript** - Type-safe code
- **React** - UI framework
- **Vite** - Build tool and dev server
- **Web Audio API** - Audio playback
- **Vitest** - Testing framework

## License

MIT

## Credits

Built by dmvjs with love for the DJ community.

Original Kwyjibo: https://github.com/dmvjs/kwyjibo

---

**Fun fact**: "Kwyjibo" is a word Bart Simpson made up in Scrabble, claiming it means "a big, dumb, balding North American ape with no chin."
