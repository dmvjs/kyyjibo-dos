/**
 * Hamiltonian Player
 *
 * Manages playback of song pairs (2 songs playing simultaneously) using Kwyjibo's progression:
 * - Each pair = 2 songs at same tempo playing intro+main simultaneously
 * - Start at random tempo (84, 94, or 102)
 * - Play 10 pairs, one per key (Key 1→2→3...→10) at current tempo
 * - After 10 keys, switch to next tempo up (84→94→102→84→...)
 * - Uses single Hamiltonian path through all 273 songs
 * - Repeat forever with auto-reshuffle
 *
 * Ensures perfect timing and seamless transitions using Web Audio API.
 */

import type { Song, Key, Tempo, TrackType } from '../../src/music/types';
import { BEAT_COUNTS, ALL_KEYS, ALL_TEMPOS } from '../../src/music/types';
import { MUSIC_BASE_URL } from '../config';

/**
 * Calculate the duration in seconds for a track at a given tempo.
 */
function calculateTrackDuration(tempo: Tempo, type: TrackType): number {
  const secondsPerBeat = 60 / tempo;
  const beats = BEAT_COUNTS[type];
  return beats * secondsPerBeat;
}

/**
 * Seeded random number generator for reproducible shuffling.
 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * A single track (one song).
 */
export interface Track {
  song: Song;
  key: Key;
  tempo: Tempo;
  introUrl: string;
  mainUrl: string;
  introDuration: number;
  mainDuration: number;
}

/**
 * A playing track pair (two songs playing simultaneously).
 */
export interface TrackPair {
  track1: Track;
  track2: Track;
  track3?: Track; // Mannie Fresh mode hidden track
  track4?: Track; // Mannie Fresh mode hidden track
  key: Key;
  tempo: Tempo;
}

/**
 * Player state.
 */
export interface PlayerState {
  key: Key;
  tempo: Tempo;
  isPlaying: boolean;
  isPaused: boolean;
  currentPair: TrackPair | null;
  nextPair: TrackPair | null;
  progressIndex: number;
  canSkipBack: boolean;
  canSkipForward: boolean;
  mannieFreshMode: boolean;
  activeHiddenTrack: 3 | 4 | null; // Which MF track is currently playing
}

/**
 * Player events.
 */
export interface PlayerEvents {
  stateChange: PlayerState;
  pairStart: TrackPair;
  pairEnd: TrackPair;
  introStart: TrackPair;
  mainStart: TrackPair;
  error: Error;
}

type EventListener<T> = (data: T) => void;

interface ProgressionEntry {
  key: Key;
  tempo: Tempo;
}

/**
 * Hamiltonian Player implementation.
 */
export class HamiltonianPlayer {
  private songs: Song[];
  private progression: ProgressionEntry[];
  private progressIndex: number = 0;
  private hamiltonianPath: Song[]; // Single path through ALL songs
  private pathIndexesByTempo: Map<Tempo, number> = new Map(); // Track position in path per tempo
  private state: PlayerState;
  private audioContext: AudioContext | null = null;
  private currentSources: AudioBufferSourceNode[] = [];
  private scheduledTimeouts: number[] = [];
  private listeners: Map<keyof PlayerEvents, Set<EventListener<unknown>>> = new Map();
  private pairStartTime: number = 0;
  private playHistory: TrackPair[] = []; // For skip back
  private preloadedBuffers: Map<string, AudioBuffer> = new Map(); // Preloaded audio for next pair
  private track1Gain: GainNode | null = null; // Gain node for track 1 (A)
  private track2Gain: GainNode | null = null; // Gain node for track 2 (B)
  private track3Gain: GainNode | null = null; // Gain node for hidden track 3 (C) - Mannie Fresh mode
  private track4Gain: GainNode | null = null; // Gain node for hidden track 4 (D) - Mannie Fresh mode
  private masterCompressor: DynamicsCompressorNode | null = null; // Master compressor for arena sound
  private crossfaderPosition: number = 0.5; // 0 = all A, 0.5 = center, 1 = all B
  private mannieFreshMode: boolean = false; // Enable hidden tracks that alternate every 4 bars
  private mannieFreshVolume: number = 0.66; // Volume for MF tracks (0-1), default 66%
  private currentHiddenTrack: 3 | 4 = 3; // Which hidden track is currently playing (3 or 4)
  private hiddenTrackSwitchInterval: number | null = null; // Interval for switching hidden tracks
  private hiddenTrackSwitchTimeout: number | null = null; // Timeout that sets up the interval
  private playedSongIds: Set<number> = new Set(); // Track which songs have been played
  private nextPairScheduledTime: number = 0; // When next pair is scheduled to start
  private scheduledPairsCount: number = 0; // Track how many pairs are scheduled ahead
  private readonly MAX_SCHEDULED_PAIRS = 1; // Limit scheduling to prevent memory issues on iOS

  constructor(songs: Song[], initialKey?: Key, initialTempo?: Tempo) {
    this.songs = songs;

    // Create single Hamiltonian path through ALL songs
    this.hamiltonianPath = this.shuffleSongs([...songs]);

    // Initialize path indexes for each tempo (to track where we are in the path)
    for (const tempo of ALL_TEMPOS) {
      this.pathIndexesByTempo.set(tempo, 0);
    }

    // Determine starting key and tempo
    let startKey: Key;
    let startTempo: Tempo;

    if (initialKey && initialTempo) {
      startKey = initialKey;
      startTempo = initialTempo;
    } else {
      // Random starting position
      startKey = ALL_KEYS[Math.floor(Math.random() * ALL_KEYS.length)] as Key;
      startTempo = ALL_TEMPOS[Math.floor(Math.random() * ALL_TEMPOS.length)];
    }

    // Generate progression starting from the chosen key/tempo
    // This ensures we complete all 10 keys at this tempo before switching
    this.progression = this.generateProgressionFromPoint(startKey, startTempo);
    this.progressIndex = 0; // Always start at beginning of generated progression

    const currentEntry = this.progression[this.progressIndex];
    this.state = {
      key: currentEntry.key,
      tempo: currentEntry.tempo,
      isPlaying: false,
      isPaused: false,
      currentPair: null,
      nextPair: null,
      progressIndex: this.progressIndex,
      canSkipBack: false,
      canSkipForward: true,
      mannieFreshMode: false,
      activeHiddenTrack: null,
    };
  }

  /**
   * Generate the structured progression:
   * 1 pair per key, 10 keys per tempo.
   * Key 1→2→3...→10 at current tempo, then switch to next tempo.
   * Cycles: 84→94→102→84→94→102→...
   */
  private generateProgression(): ProgressionEntry[] {
    const progression: ProgressionEntry[] = [];
    const KEYS_TO_USE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as Key[];

    // Generate enough entries for continuous playback
    // Repeat the 30-entry cycle (10 keys × 3 tempos)
    for (let cycle = 0; cycle < 10; cycle++) {
      for (const tempo of ALL_TEMPOS) {
        for (const key of KEYS_TO_USE) {
          progression.push({ key, tempo });
        }
      }
    }

    return progression;
  }

  /**
   * Shuffle songs using seeded random.
   */
  private shuffleSongs(songs: Song[]): Song[] {
    const shuffled = [...songs];
    const rng = seededRandom(Date.now());

    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
  }

  /**
   * Get the next song from the Hamiltonian path at the specified tempo.
   * Searches forward in the path for a song at the required tempo.
   * Reshuffles the entire path when we've exhausted all tempos.
   * Optionally avoids songs by specified artists for variety.
   */
  private getNextSong(tempo: Tempo, avoidArtists: string[] = []): Song {
    // Safety check: ensure we have songs and a path
    if (!this.hamiltonianPath || this.hamiltonianPath.length === 0) {
      console.log('🔄 Hamiltonian path empty, reshuffling');
      this.hamiltonianPath = this.shuffleSongs([...this.songs]);
      for (const t of ALL_TEMPOS) {
        this.pathIndexesByTempo.set(t, 0);
      }
    }

    const startIndex = this.pathIndexesByTempo.get(tempo) || 0;
    let searchIndex = startIndex;
    let wrapped = false;
    let attempts = 0;
    const maxAttempts = this.hamiltonianPath.length * 2; // Prevent infinite loops
    let fallbackSong: Song | null = null; // Fallback if we can't avoid all artists

    // Search for next song at this tempo
    while (attempts < maxAttempts) {
      attempts++;

      // Bounds check
      if (searchIndex >= this.hamiltonianPath.length) {
        searchIndex = 0;
        wrapped = true;
      }

      const song = this.hamiltonianPath[searchIndex];

      // Safety check: if song is undefined, skip
      if (!song) {
        searchIndex++;
        continue;
      }

      if (song.bpm === tempo) {
        // Check if we should avoid this artist
        const shouldAvoid = avoidArtists.length > 0 && avoidArtists.includes(song.artist);

        if (!shouldAvoid) {
          // Found a matching song with acceptable artist
          this.pathIndexesByTempo.set(tempo, searchIndex + 1);
          return song;
        } else if (!fallbackSong) {
          // Save as fallback in case we can't find a non-avoided artist
          fallbackSong = song;
        }
      }

      searchIndex++;

      // If we've wrapped around and returned to start, use fallback or reshuffle
      if (wrapped && searchIndex >= startIndex) {
        if (fallbackSong) {
          // Use the fallback song (same artist, but better than nothing)
          const fallbackIndex = this.hamiltonianPath.indexOf(fallbackSong);
          this.pathIndexesByTempo.set(tempo, fallbackIndex + 1);
          return fallbackSong;
        }

        console.log(`🔄 Reshuffling entire Hamiltonian path (all ${this.songs.length} songs)`);
        this.hamiltonianPath = this.shuffleSongs([...this.songs]);
        // Reset all tempo indexes
        for (const t of ALL_TEMPOS) {
          this.pathIndexesByTempo.set(t, 0);
        }
        // Restart search from beginning (without artist avoidance to prevent infinite loop)
        return this.getNextSong(tempo, []);
      }
    }

    // Fallback: if we somehow exit the loop, use fallback or reshuffle
    if (fallbackSong) {
      return fallbackSong;
    }

    console.log('⚠️ getNextSong exceeded max attempts, reshuffling');
    this.hamiltonianPath = this.shuffleSongs([...this.songs]);
    for (const t of ALL_TEMPOS) {
      this.pathIndexesByTempo.set(t, 0);
    }

    // Return first song at this tempo or any song as last resort
    const lastResort = this.hamiltonianPath.find(s => s.bpm === tempo) || this.hamiltonianPath[0];
    if (lastResort) {
      return lastResort;
    }

    // Absolute last resort: throw error
    throw new Error('No songs available');
  }

  /**
   * Create a single track.
   */
  private createTrack(song: Song, key: Key, tempo: Tempo): Track {
    const songId = String(song.id).padStart(8, '0');
    return {
      song,
      key,
      tempo,
      introUrl: `${MUSIC_BASE_URL}${songId}-lead.mp3`,
      mainUrl: `${MUSIC_BASE_URL}${songId}-body.mp3`,
      introDuration: calculateTrackDuration(tempo, 'lead'),
      mainDuration: calculateTrackDuration(tempo, 'body'),
    };
  }

  /**
   * Create a track pair (two songs playing simultaneously).
   */
  private createTrackPair(song1: Song, song2: Song, key: Key, tempo: Tempo): TrackPair {
    return {
      track1: this.createTrack(song1, key, tempo),
      track2: this.createTrack(song2, key, tempo),
      key,
      tempo,
    };
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();

      // Create master compressor for arena sound (punchy, loud, controlled)
      this.masterCompressor = this.audioContext.createDynamicsCompressor();
      this.masterCompressor.threshold.setValueAtTime(-24, this.audioContext.currentTime);
      this.masterCompressor.knee.setValueAtTime(30, this.audioContext.currentTime);
      this.masterCompressor.ratio.setValueAtTime(12, this.audioContext.currentTime);
      this.masterCompressor.attack.setValueAtTime(0.003, this.audioContext.currentTime);
      this.masterCompressor.release.setValueAtTime(0.25, this.audioContext.currentTime);
      this.masterCompressor.connect(this.audioContext.destination);

      // Create gain nodes for crossfading
      this.track1Gain = this.audioContext.createGain();
      this.track2Gain = this.audioContext.createGain();

      // Create gain nodes for hidden tracks (Mannie Fresh mode)
      this.track3Gain = this.audioContext.createGain();
      this.track4Gain = this.audioContext.createGain();

      // Connect all gain nodes through the master compressor
      this.track1Gain.connect(this.masterCompressor);
      this.track2Gain.connect(this.masterCompressor);
      this.track3Gain.connect(this.masterCompressor);
      this.track4Gain.connect(this.masterCompressor);

      // Set initial crossfader position (center)
      this.updateCrossfaderGains();

      // Set hidden tracks to silent by default (will be controlled by Mannie Fresh mode)
      this.updateHiddenTrackGains();
    }
    return this.audioContext;
  }

  /**
   * Update gain values based on crossfader position.
   * Uses smooth equal-power crossfading curve.
   */
  private updateCrossfaderGains(): void {
    if (!this.track1Gain || !this.track2Gain || !this.audioContext) return;

    // Equal-power crossfading curve for smooth transitions
    const position = this.crossfaderPosition;
    const gain1 = Math.cos(position * 0.5 * Math.PI);
    const gain2 = Math.cos((1.0 - position) * 0.5 * Math.PI);

    const now = this.audioContext.currentTime;
    // Use exponentialRampToValueAtTime for silky smooth transitions
    this.track1Gain.gain.setTargetAtTime(gain1, now, 0.015);
    this.track2Gain.gain.setTargetAtTime(gain2, now, 0.015);
  }

  /**
   * Set crossfader position (0 = all track 1, 0.5 = center, 1 = all track 2).
   */
  setCrossfader(position: number): void {
    this.crossfaderPosition = Math.max(0, Math.min(1, position));
    this.updateCrossfaderGains();
  }

  /**
   * Get current crossfader position.
   */
  getCrossfader(): number {
    return this.crossfaderPosition;
  }

  /**
   * Update gain values for hidden tracks (Mannie Fresh mode).
   * Track 3 and 4 alternate every 4 bars at configured volume when enabled.
   */
  private updateHiddenTrackGains(): void {
    if (!this.track3Gain || !this.track4Gain || !this.audioContext) return;

    const now = this.audioContext.currentTime;

    if (this.mannieFreshMode) {
      // Apply volume setting to the active hidden track, silent for the inactive one
      const gain3 = this.currentHiddenTrack === 3 ? this.mannieFreshVolume : 0;
      const gain4 = this.currentHiddenTrack === 4 ? this.mannieFreshVolume : 0;

      this.track3Gain.gain.setTargetAtTime(gain3, now, 0.015);
      this.track4Gain.gain.setTargetAtTime(gain4, now, 0.015);
    } else {
      // Silent when mode is off
      this.track3Gain.gain.setTargetAtTime(0, now, 0.015);
      this.track4Gain.gain.setTargetAtTime(0, now, 0.015);
    }
  }

  /**
   * Calculate 4-bar duration in seconds based on current tempo.
   * 4 bars = 16 beats in 4/4 time (for MF switching)
   */
  private calculate4BarDuration(tempo: Tempo): number {
    const secondsPerBeat = 60 / tempo;
    return 16 * secondsPerBeat; // 4 bars × 4 beats/bar = 16 beats
  }

  /**
   * Get a musically related key using various harmonic relationships.
   * Uses circle of fifths, parallel modes, relative keys, and other theory.
   */
  private getMusicallyRelatedKey(baseKey: Key): Key {
    const relationships = [
      7,   // Perfect 5th up (dominant)
      5,   // Perfect 4th up (subdominant)
      -7,  // Perfect 5th down
      -5,  // Perfect 4th down
      3,   // Relative minor/major (minor 3rd)
      -3,  // Relative minor/major (minor 3rd down)
      6,   // Tritone (devil's interval)
      2,   // Whole step up (pentatonic relation)
      -2,  // Whole step down
      4,   // Major 3rd (mediant)
      -4,  // Major 3rd down
    ];

    // Pick a random relationship
    const relationship = relationships[Math.floor(Math.random() * relationships.length)];

    // Calculate new key (mod 12 for octave wrap, +1 because keys are 1-indexed)
    let newKey = ((baseKey - 1 + relationship) % 12);
    if (newKey < 0) newKey += 12;

    // Ensure we stay within the valid key range (1-10)
    return (Math.max(1, Math.min(10, newKey + 1))) as Key;
  }

  /**
   * Toggle Mannie Fresh mode on/off.
   * When enabled, two hidden tracks play at full volume, alternating every 8 bars.
   */
  toggleMannieFreshMode(): void {
    this.mannieFreshMode = !this.mannieFreshMode;
    this.updateHiddenTrackGains();
    this.updateState({
      mannieFreshMode: this.mannieFreshMode,
      activeHiddenTrack: this.mannieFreshMode ? this.currentHiddenTrack : null,
    });

    if (this.mannieFreshMode) {
      console.log('🎵 Mannie Fresh mode ACTIVATED - Tracks will alternate every 8 beats');
    } else {
      console.log('🎵 Mannie Fresh mode DEACTIVATED');
    }

    // Note: Switching is handled by the beat-synced interval set up when the pair starts.
    // No need to create a new interval here - just let the existing one handle it.
  }

  /**
   * Get current Mannie Fresh mode state.
   */
  getMannieFreshMode(): boolean {
    return this.mannieFreshMode;
  }

  /**
   * Set Mannie Fresh volume (0-1).
   */
  setMannieFreshVolume(volume: number): void {
    this.mannieFreshVolume = Math.max(0, Math.min(1, volume));
    this.updateHiddenTrackGains();
  }

  /**
   * Get current Mannie Fresh volume.
   */
  getMannieFreshVolume(): number {
    return this.mannieFreshVolume;
  }

  /**
   * Schedule hidden tracks for a scheduled pair (used in scheduleNextPair).
   */
  private async scheduleHiddenTracksForScheduledPair(
    pair: TrackPair,
    pairStartTime: number,
    pairEndTime: number
  ): Promise<void> {
    // Add tracks to pair if not already present
    if (!pair.track3 || !pair.track4) {
      const relatedKey3 = this.getMusicallyRelatedKey(pair.key);
      const relatedKey4 = this.getMusicallyRelatedKey(pair.key);

      const song3 = this.getNextSong(pair.tempo, [
        pair.track1.song.artist,
        pair.track2.song.artist,
      ]);
      const song4 = this.getNextSong(pair.tempo, [
        pair.track1.song.artist,
        pair.track2.song.artist,
        song3.artist,
      ]);

      pair.track3 = this.createTrack(song3, relatedKey3, pair.tempo);
      pair.track4 = this.createTrack(song4, relatedKey4, pair.tempo);
    }

    // Calculate mainStartTime using the same logic as playPair
    const intro1Duration = pair.track1.introDuration;
    const intro2Duration = pair.track2.introDuration;
    const idealIntroDuration = Math.max(intro1Duration, intro2Duration);
    const mainStartTime = pairStartTime + idealIntroDuration;

    // Now schedule the audio using the existing method
    await this.scheduleHiddenTracks(pair, pairStartTime, mainStartTime, pairEndTime);
  }

  /**
   * Schedule hidden tracks (Mannie Fresh mode).
   * Picks songs in musically related keys and alternates them every 4 bars.
   */
  private async scheduleHiddenTracks(
    pair: TrackPair,
    pairStartTime: number,
    mainStartTime: number,
    pairEndTime: number,
    isCurrentPair: boolean = false,
    preloadedBuffers?: {
      intro3Buffer: AudioBuffer;
      main3Buffer: AudioBuffer;
      intro4Buffer: AudioBuffer;
      main4Buffer: AudioBuffer;
    }
  ): Promise<void> {
    try {
      const ctx = this.ensureAudioContext();

      // Only clear the interval if this is the current pair starting playback
      // Don't clear it when pre-scheduling the next pair
      if (isCurrentPair && this.hiddenTrackSwitchInterval !== null) {
        clearInterval(this.hiddenTrackSwitchInterval);
      }

      // Only create tracks if they don't already exist (they might be pre-created)
      if (!pair.track3 || !pair.track4) {
        // Pick two songs in musically related keys
        const relatedKey3 = this.getMusicallyRelatedKey(pair.key);
        const relatedKey4 = this.getMusicallyRelatedKey(pair.key);

        // Get songs for hidden tracks (avoid songs already playing)
        const song3 = this.getNextSong(pair.tempo, [
          pair.track1.song.artist,
          pair.track2.song.artist,
        ]);
        const song4 = this.getNextSong(pair.tempo, [
          pair.track1.song.artist,
          pair.track2.song.artist,
          song3.artist,
        ]);

        // Create tracks for hidden songs
        const track3 = this.createTrack(song3, relatedKey3, pair.tempo);
        const track4 = this.createTrack(song4, relatedKey4, pair.tempo);

        // Add tracks to the current pair for UI display
        pair.track3 = track3;
        pair.track4 = track4;
      }

      const track3 = pair.track3!;
      const track4 = pair.track4!;

      console.log(
        `🎵 Mannie Fresh: Track 3: ${track3.song.title} (${track3.song.artist}) in key ${track3.key}`
      );
      console.log(
        `🎵 Mannie Fresh: Track 4: ${track4.song.title} (${track4.song.artist}) in key ${track4.key}`
      );

      // Load audio for both hidden tracks (unless already provided)
      let intro3Buffer: AudioBuffer, main3Buffer: AudioBuffer, intro4Buffer: AudioBuffer, main4Buffer: AudioBuffer;
      if (preloadedBuffers) {
        // Use pre-loaded buffers for perfect alignment
        intro3Buffer = preloadedBuffers.intro3Buffer;
        main3Buffer = preloadedBuffers.main3Buffer;
        intro4Buffer = preloadedBuffers.intro4Buffer;
        main4Buffer = preloadedBuffers.main4Buffer;
      } else {
        // Load buffers now (for scheduled pairs)
        [intro3Buffer, main3Buffer, intro4Buffer, main4Buffer] = await Promise.all([
          this.loadAudioBuffer(track3.introUrl),
          this.loadAudioBuffer(track3.mainUrl),
          this.loadAudioBuffer(track4.introUrl),
          this.loadAudioBuffer(track4.mainUrl),
        ]);
      }

      // Use the exact same timing as main tracks (passed as parameter)

      // Schedule Track 3 (intro + main)
      const intro3Source = ctx.createBufferSource();
      intro3Source.buffer = intro3Buffer;
      intro3Source.connect(this.track3Gain!);
      intro3Source.start(pairStartTime);
      console.log(`▶️ Started Track 3 intro at ${pairStartTime}`);
      intro3Source.onended = () => {
        intro3Source.disconnect();
        const idx = this.currentSources.indexOf(intro3Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro3Source);

      const main3Source = ctx.createBufferSource();
      main3Source.buffer = main3Buffer;
      main3Source.connect(this.track3Gain!);
      main3Source.start(mainStartTime);
      console.log(`▶️ Scheduled Track 3 main at ${mainStartTime}`);
      main3Source.onended = () => {
        main3Source.disconnect();
        const idx = this.currentSources.indexOf(main3Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(main3Source);

      // Schedule Track 4 (intro + main)
      const intro4Source = ctx.createBufferSource();
      intro4Source.buffer = intro4Buffer;
      intro4Source.connect(this.track4Gain!);
      intro4Source.start(pairStartTime);
      console.log(`▶️ Started Track 4 intro at ${pairStartTime}`);
      intro4Source.onended = () => {
        intro4Source.disconnect();
        const idx = this.currentSources.indexOf(intro4Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro4Source);

      const main4Source = ctx.createBufferSource();
      main4Source.buffer = main4Buffer;
      main4Source.connect(this.track4Gain!);
      main4Source.start(mainStartTime);
      console.log(`▶️ Scheduled Track 4 main at ${mainStartTime}`);
      main4Source.onended = () => {
        main4Source.disconnect();
        const idx = this.currentSources.indexOf(main4Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(main4Source);

      // Only set up the switching interval for the current pair
      if (isCurrentPair) {
        // Calculate 4-bar (16 beat) duration for alternation
        const fourBarDuration = this.calculate4BarDuration(pair.tempo);

        // Reset hidden track state and set gains
        this.currentHiddenTrack = 3;
        this.updateHiddenTrackGains();

        console.log(
          `🔊 Track 3 gain: ${this.track3Gain!.gain.value}, Track 4 gain: ${this.track4Gain!.gain.value}`
        );

        // Clear any existing timeout and interval
        if (this.hiddenTrackSwitchTimeout !== null) {
          clearTimeout(this.hiddenTrackSwitchTimeout);
          this.hiddenTrackSwitchTimeout = null;
        }
        if (this.hiddenTrackSwitchInterval !== null) {
          clearInterval(this.hiddenTrackSwitchInterval);
          this.hiddenTrackSwitchInterval = null;
        }

        // Calculate when to start switching (when main section begins)
        const firstSwitchDelay = (mainStartTime - ctx.currentTime) * 1000;

        // Set up switching to start when main section begins
        // One track plays throughout intro, then switches at main start, then every 16 beats
        this.hiddenTrackSwitchTimeout = window.setTimeout(() => {
          if (!this.state.isPlaying) return;

          // Switch to the other track when main starts
          this.currentHiddenTrack = this.currentHiddenTrack === 3 ? 4 : 3;
          this.updateHiddenTrackGains();
          this.updateState({
            activeHiddenTrack: this.mannieFreshMode ? this.currentHiddenTrack : null,
          });
          console.log(`🔄 Mannie Fresh: Main started, switched to track ${this.currentHiddenTrack}`);

          // Set up interval to continue switching every 16 beats (4 bars)
          this.hiddenTrackSwitchInterval = window.setInterval(() => {
            // Only switch if MF mode is ON
            if (!this.mannieFreshMode) {
              return;
            }

            // Alternate between track 3 and 4
            this.currentHiddenTrack = this.currentHiddenTrack === 3 ? 4 : 3;
            this.updateHiddenTrackGains();

            // Update state to show active track in UI
            this.updateState({
              activeHiddenTrack: this.mannieFreshMode ? this.currentHiddenTrack : null,
            });

            console.log(`🔄 Mannie Fresh: Switched to hidden track ${this.currentHiddenTrack}`);
          }, fourBarDuration * 1000); // Switch every 16 beats (4 bars)
        }, Math.max(0, firstSwitchDelay));
      }

    } catch (err) {
      console.error('Error scheduling hidden tracks:', err);
    }
  }

  private emit<K extends keyof PlayerEvents>(event: K, data: PlayerEvents[K]): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          (listener as EventListener<PlayerEvents[K]>)(data);
        } catch (err) {
          console.error(`Error in ${event} listener:`, err);
        }
      });
    }
  }

  on<K extends keyof PlayerEvents>(event: K, listener: EventListener<PlayerEvents[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<unknown>);

    return () => {
      const listeners = this.listeners.get(event);
      if (listeners) {
        listeners.delete(listener as EventListener<unknown>);
      }
    };
  }

  private updateState(updates: Partial<PlayerState>): void {
    this.state = {
      ...this.state,
      ...updates,
      canSkipBack: this.playHistory.length > 0,
      canSkipForward: true,
    };
    this.emit('stateChange', this.state);
  }

  /**
   * Clear all scheduled timeouts.
   */
  private clearScheduled(): void {
    this.scheduledTimeouts.forEach((id) => clearTimeout(id));
    this.scheduledTimeouts = [];
  }

  /**
   * Start playback.
   */
  async play(): Promise<void> {
    const ctx = this.ensureAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    if (this.state.isPaused) {
      // Resume from pause
      await ctx.resume();
      this.updateState({ isPlaying: true, isPaused: false });
      return;
    }

    // Prepare first two pairs (each pair has 2 songs at same tempo)
    const entry1 = this.progression[this.progressIndex];
    const entry2 = this.progression[(this.progressIndex + 1) % this.progression.length];

    // Pair 1: avoid same artist
    const song1a = this.getNextSong(entry1.tempo);
    const song1b = this.getNextSong(entry1.tempo, [song1a.artist]);

    // Pair 2: avoid same artist within pair and artists from pair 1
    const song2a = this.getNextSong(entry2.tempo, [song1a.artist, song1b.artist]);
    const song2b = this.getNextSong(entry2.tempo, [song2a.artist, song1a.artist, song1b.artist]);

    const currentPair = this.createTrackPair(song1a, song1b, entry1.key, entry1.tempo);
    const nextPair = this.createTrackPair(song2a, song2b, entry2.key, entry2.tempo);

    // Add hidden tracks to currentPair (first pair)
    const currentRelatedKey3 = this.getMusicallyRelatedKey(entry1.key);
    const currentRelatedKey4 = this.getMusicallyRelatedKey(entry1.key);
    const currentSong3 = this.getNextSong(entry1.tempo, [song1a.artist, song1b.artist]);
    const currentSong4 = this.getNextSong(entry1.tempo, [song1a.artist, song1b.artist, currentSong3.artist]);
    currentPair.track3 = this.createTrack(currentSong3, currentRelatedKey3, entry1.tempo);
    currentPair.track4 = this.createTrack(currentSong4, currentRelatedKey4, entry1.tempo);

    // Add hidden tracks to nextPair
    const relatedKey3 = this.getMusicallyRelatedKey(entry2.key);
    const relatedKey4 = this.getMusicallyRelatedKey(entry2.key);
    const song3 = this.getNextSong(entry2.tempo, [song2a.artist, song2b.artist]);
    const song4 = this.getNextSong(entry2.tempo, [song2a.artist, song2b.artist, song3.artist]);
    nextPair.track3 = this.createTrack(song3, relatedKey3, entry2.tempo);
    nextPair.track4 = this.createTrack(song4, relatedKey4, entry2.tempo);

    // Preload both current and next pair for seamless transitions
    await Promise.all([
      this.preloadNextPair(currentPair),
      this.preloadNextPair(nextPair)
    ]);

    this.updateState({
      isPlaying: true,
      isPaused: false,
      currentPair,
      nextPair,
      key: entry1.key,
      tempo: entry1.tempo,
      progressIndex: this.progressIndex,
    });

    await this.playPair(currentPair);
  }

  /**
   * Play a pair with perfect timing (two songs simultaneously).
   * Uses pure Web Audio API scheduling - NO setTimeout for audio timing.
   */
  private async playPair(pair: TrackPair, startTime?: number): Promise<void> {
    if (!this.state.isPlaying) return;

    try {
      const ctx = this.ensureAudioContext();
      this.playHistory.push(pair);
      if (this.playHistory.length > 10) {
        this.playHistory.shift();
      }

      // Track played songs
      this.playedSongIds.add(pair.track1.song.id);
      this.playedSongIds.add(pair.track2.song.id);

      // Load audio for ALL tracks (1, 2, 3, 4) before starting playback
      // This ensures perfect alignment - all tracks start together
      const [intro1Buffer, main1Buffer, intro2Buffer, main2Buffer, intro3Buffer, main3Buffer, intro4Buffer, main4Buffer] = await Promise.all([
        this.loadAudioBuffer(pair.track1.introUrl),
        this.loadAudioBuffer(pair.track1.mainUrl),
        this.loadAudioBuffer(pair.track2.introUrl),
        this.loadAudioBuffer(pair.track2.mainUrl),
        this.loadAudioBuffer(pair.track3!.introUrl),
        this.loadAudioBuffer(pair.track3!.mainUrl),
        this.loadAudioBuffer(pair.track4!.introUrl),
        this.loadAudioBuffer(pair.track4!.mainUrl),
      ]);

      // Calculate precise start time using Web Audio API
      // Give more buffer time (0.1s) to ensure all tracks are ready
      if (startTime !== undefined) {
        this.pairStartTime = startTime;
      } else {
        this.pairStartTime = ctx.currentTime + 0.1;
      }

      // Calculate all timing using IDEAL durations for perfect mathematical grid
      // This is the Kwyjibo way - schedule based on tempo math, not actual buffer duration
      const idealIntroDuration = pair.track1.introDuration;
      const idealMainDuration = pair.track1.mainDuration;
      const mainStartTime = this.pairStartTime + idealIntroDuration;
      const pairEndTime = mainStartTime + idealMainDuration;

      // Schedule Track 1 intro + main with Web Audio API (sample-accurate)
      const intro1Source = ctx.createBufferSource();
      intro1Source.buffer = intro1Buffer;
      intro1Source.connect(this.track1Gain!);
      intro1Source.start(this.pairStartTime);
      intro1Source.onended = () => {
        intro1Source.disconnect();
        const idx = this.currentSources.indexOf(intro1Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro1Source);

      const main1Source = ctx.createBufferSource();
      main1Source.buffer = main1Buffer;
      main1Source.connect(this.track1Gain!);
      main1Source.start(mainStartTime);
      main1Source.onended = () => {
        main1Source.disconnect();
        const idx = this.currentSources.indexOf(main1Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(main1Source);

      // Schedule Track 2 intro + main with Web Audio API (sample-accurate)
      const intro2Source = ctx.createBufferSource();
      intro2Source.buffer = intro2Buffer;
      intro2Source.connect(this.track2Gain!);
      intro2Source.start(this.pairStartTime);
      intro2Source.onended = () => {
        intro2Source.disconnect();
        const idx = this.currentSources.indexOf(intro2Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro2Source);

      const main2Source = ctx.createBufferSource();
      main2Source.buffer = main2Buffer;
      main2Source.connect(this.track2Gain!);
      main2Source.start(mainStartTime);
      main2Source.onended = () => {
        main2Source.disconnect();
        const idx = this.currentSources.indexOf(main2Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(main2Source);

      // Always schedule hidden tracks (they're silent unless MF mode is on)
      // Pass pre-loaded buffers for perfect alignment
      await this.scheduleHiddenTracks(pair, this.pairStartTime, mainStartTime, pairEndTime, true, {
        intro3Buffer,
        main3Buffer,
        intro4Buffer,
        main4Buffer
      });

      this.emit('pairStart', pair);
      this.emit('introStart', pair);

      // IMMEDIATELY schedule the next pair to start at pairEndTime
      // This is the key to flawless timing - don't wait, schedule NOW
      this.nextPairScheduledTime = pairEndTime;
      void this.scheduleNextPair(pairEndTime);

      // setTimeout ONLY for UI events (never for audio timing)
      const mainDelay = (mainStartTime - ctx.currentTime) * 1000;
      const mainTimeoutId = window.setTimeout(() => {
        this.emit('mainStart', pair);
      }, Math.max(0, mainDelay));
      this.scheduledTimeouts.push(mainTimeoutId);

      const pairEndDelay = (pairEndTime - ctx.currentTime) * 1000;
      const pairEndTimeoutId = window.setTimeout(() => {
        this.emit('pairEnd', pair);
      }, Math.max(0, pairEndDelay));
      this.scheduledTimeouts.push(pairEndTimeoutId);

    } catch (err) {
      this.emit('error', err as Error);
    }
  }

  /**
   * Schedule the next pair to start at a precise time.
   * This is called IMMEDIATELY when current pair starts, not when it ends.
   */
  private async scheduleNextPair(startTime: number): Promise<void> {
    if (!this.state.isPlaying) return;

    // Limit scheduling ahead to prevent memory issues on iOS
    if (this.scheduledPairsCount >= this.MAX_SCHEDULED_PAIRS) {
      // Schedule this call to happen later when a pair finishes
      const delayUntilSchedule = (startTime - this.ensureAudioContext().currentTime - 5) * 1000;
      setTimeout(() => {
        // Don't decrement here - it's handled when pair actually starts (line 671)
        void this.scheduleNextPair(startTime);
      }, Math.max(0, delayUntilSchedule));
      return;
    }

    this.scheduledPairsCount++;

    try {
      const ctx = this.ensureAudioContext();

      // Preload next pair immediately
      if (!this.state.nextPair) return;
      console.log(`🔄 Preloading pair to schedule at time ${startTime.toFixed(2)}`);
      await this.preloadNextPair(this.state.nextPair);
      console.log(`✅ Preload complete`);

      const pairToSchedule = this.state.nextPair;

      // Load audio for the pair we're about to schedule
      const [intro1Buffer, main1Buffer, intro2Buffer, main2Buffer] = await Promise.all([
        this.loadAudioBuffer(pairToSchedule.track1.introUrl),
        this.loadAudioBuffer(pairToSchedule.track1.mainUrl),
        this.loadAudioBuffer(pairToSchedule.track2.introUrl),
        this.loadAudioBuffer(pairToSchedule.track2.mainUrl),
      ]);

      // Calculate timing using ideal durations
      const idealIntroDuration = pairToSchedule.track1.introDuration;
      const idealMainDuration = pairToSchedule.track1.mainDuration;
      const mainStartTime = startTime + idealIntroDuration;
      const pairEndTime = mainStartTime + idealMainDuration;

      // Schedule all 4 sources at precise times
      console.log(`🎵 Scheduling pair at time ${startTime.toFixed(2)} (current: ${ctx.currentTime.toFixed(2)}, delta: ${(startTime - ctx.currentTime).toFixed(2)}s)`);
      const intro1Source = ctx.createBufferSource();
      intro1Source.buffer = intro1Buffer;
      intro1Source.connect(this.track1Gain!);
      intro1Source.start(startTime);

      // Clean up source after it finishes to prevent memory leaks
      intro1Source.onended = () => {
        intro1Source.disconnect();
        const idx = this.currentSources.indexOf(intro1Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro1Source);

      const main1Source = ctx.createBufferSource();
      main1Source.buffer = main1Buffer;
      main1Source.connect(this.track1Gain!);
      main1Source.start(mainStartTime);

      main1Source.onended = () => {
        main1Source.disconnect();
        const idx = this.currentSources.indexOf(main1Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(main1Source);

      const intro2Source = ctx.createBufferSource();
      intro2Source.buffer = intro2Buffer;
      intro2Source.connect(this.track2Gain!);
      intro2Source.start(startTime);

      intro2Source.onended = () => {
        intro2Source.disconnect();
        const idx = this.currentSources.indexOf(intro2Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro2Source);

      const main2Source = ctx.createBufferSource();
      main2Source.buffer = main2Buffer;
      main2Source.connect(this.track2Gain!);
      main2Source.start(mainStartTime);

      main2Source.onended = () => {
        main2Source.disconnect();
        const idx = this.currentSources.indexOf(main2Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(main2Source);

      // Always schedule hidden tracks (they're silent unless MF mode is on)
      await this.scheduleHiddenTracksForScheduledPair(pairToSchedule, startTime, pairEndTime);

      // Track played songs
      this.playedSongIds.add(pairToSchedule.track1.song.id);
      this.playedSongIds.add(pairToSchedule.track2.song.id);
      this.playHistory.push(pairToSchedule);

      // Update progression index (move to the pair we just scheduled)
      this.progressIndex = (this.progressIndex + 1) % this.progression.length;

      // Prepare the NEW next pair - avoid artists from the pair we just scheduled
      const nextEntry = this.progression[(this.progressIndex + 1) % this.progression.length];
      const avoidArtists = [
        pairToSchedule.track1.song.artist,
        pairToSchedule.track2.song.artist
      ];
      const song1 = this.getNextSong(nextEntry.tempo, avoidArtists);
      const song2 = this.getNextSong(nextEntry.tempo, [...avoidArtists, song1.artist]);
      const newNextPair = this.createTrackPair(song1, song2, nextEntry.key, nextEntry.tempo);

      // Add hidden tracks to the new next pair
      const relatedKey3 = this.getMusicallyRelatedKey(nextEntry.key);
      const relatedKey4 = this.getMusicallyRelatedKey(nextEntry.key);
      const song3 = this.getNextSong(nextEntry.tempo, [song1.artist, song2.artist]);
      const song4 = this.getNextSong(nextEntry.tempo, [song1.artist, song2.artist, song3.artist]);
      newNextPair.track3 = this.createTrack(song3, relatedKey3, nextEntry.tempo);
      newNextPair.track4 = this.createTrack(song4, relatedKey4, nextEntry.tempo);

      // Update state.nextPair immediately (synchronously) so recursive scheduling works
      // The full UI update happens in setTimeout below
      this.state.nextPair = newNextPair;

      // Schedule UI state update to happen when the pair ACTUALLY starts playing
      const pairStartDelay = (startTime - ctx.currentTime) * 1000;
      setTimeout(() => {
        if (!this.state.isPlaying) return;

        // Decrement counter when pair actually starts (frees up scheduling slot)
        if (this.scheduledPairsCount > 0) {
          this.scheduledPairsCount--;
        }

        this.updateState({
          currentPair: pairToSchedule,
          nextPair: newNextPair,
          key: this.progression[this.progressIndex].key,
          tempo: this.progression[this.progressIndex].tempo,
          progressIndex: this.progressIndex,
        });
        this.emit('pairStart', pairToSchedule);
        this.emit('introStart', pairToSchedule);
      }, Math.max(0, pairStartDelay));

      // Schedule UI events
      const mainDelay = (mainStartTime - ctx.currentTime) * 1000;
      setTimeout(() => this.emit('mainStart', pairToSchedule), Math.max(0, mainDelay));

      const pairEndDelay = (pairEndTime - ctx.currentTime) * 1000;
      setTimeout(() => this.emit('pairEnd', pairToSchedule), Math.max(0, pairEndDelay));

      // Recursively schedule the next pair
      void this.scheduleNextPair(pairEndTime);

    } catch (err) {
      this.emit('error', err as Error);
    }
  }

  /**
   * Load audio buffer.
   */
  private async loadAudioBuffer(url: string): Promise<AudioBuffer> {
    // Check if already cached
    if (this.preloadedBuffers.has(url)) {
      console.log(`📦 Using cached buffer for ${url.split('/').pop()}`);
      return this.preloadedBuffers.get(url)!;
    }

    console.log(`⬇️ Downloading ${url.split('/').pop()}`);
    const ctx = this.ensureAudioContext();
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arrayBuffer);

    // Cache it for future use (keep in cache, don't delete)
    this.preloadedBuffers.set(url, buffer);

    // Limit cache size to prevent memory issues on iOS
    // Keep only the most recent 12 buffers (3 pairs × 4 files)
    if (this.preloadedBuffers.size > 12) {
      const firstKey = this.preloadedBuffers.keys().next().value;
      this.preloadedBuffers.delete(firstKey);
    }

    return buffer;
  }

  /**
   * Preload the next pair's audio for seamless cueing (Kwyjibo style).
   */
  private async preloadNextPair(pair: TrackPair): Promise<void> {
    try {
      const ctx = this.ensureAudioContext();
      const urls = [
        pair.track1.introUrl,
        pair.track1.mainUrl,
        pair.track2.introUrl,
        pair.track2.mainUrl,
      ];

      // Load all 4 files in parallel and cache them
      await Promise.all(
        urls.map(async (url) => {
          if (!this.preloadedBuffers.has(url)) {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = await ctx.decodeAudioData(arrayBuffer);
            this.preloadedBuffers.set(url, buffer);
          }
        })
      );
    } catch (err) {
      console.error('Error preloading next pair:', err);
    }
  }

  /**
   * Advance to next pair.
   * Uses precise Web Audio timing for seamless transitions.
   */
  private async advanceToNextPair(startTime?: number): Promise<void> {
    if (!this.state.isPlaying || this.state.isPaused) return;

    // Move to next progression entry
    this.progressIndex = (this.progressIndex + 1) % this.progression.length;
    const nextEntry = this.progression[(this.progressIndex + 1) % this.progression.length];

    // Current next becomes current (already preloaded!)
    const newCurrent = this.state.nextPair;
    if (!newCurrent) return;

    // Get new next pair (2 songs at same tempo) - avoid artists from newCurrent
    const avoidArtists = [newCurrent.track1.song.artist, newCurrent.track2.song.artist];
    const nextSongA = this.getNextSong(nextEntry.tempo, avoidArtists);
    const nextSongB = this.getNextSong(nextEntry.tempo, [...avoidArtists, nextSongA.artist]);
    const newNext = this.createTrackPair(nextSongA, nextSongB, nextEntry.key, nextEntry.tempo);

    // Preload the NEW next pair immediately (before updating state)
    await this.preloadNextPair(newNext);

    this.updateState({
      currentPair: newCurrent,
      nextPair: newNext,
      key: this.progression[this.progressIndex].key,
      tempo: this.progression[this.progressIndex].tempo,
      progressIndex: this.progressIndex,
    });

    // Play with precise timing (use provided startTime for seamless transition)
    await this.playPair(newCurrent, startTime);
  }

  /**
   * Pause playback.
   */
  async pause(): Promise<void> {
    if (!this.state.isPlaying || this.state.isPaused) return;

    const ctx = this.ensureAudioContext();
    await ctx.suspend();

    this.clearScheduled();
    this.updateState({ isPaused: true, isPlaying: false });
  }

  /**
   * Stop playback.
   */
  stop(): void {
    this.clearScheduled();

    this.currentSources.forEach((source) => {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Already stopped
      }
    });
    this.currentSources = [];

    // Clear preloaded buffers to free memory
    this.preloadedBuffers.clear();
    this.scheduledPairsCount = 0;

    this.updateState({
      isPlaying: false,
      isPaused: false,
      currentPair: null,
      nextPair: null,
    });
  }

  /**
   * Skip to next pair.
   */
  async skipForward(): Promise<void> {
    if (!this.state.isPlaying) return;

    // Stop current
    this.clearScheduled();
    this.currentSources.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    this.currentSources = [];

    // Jump to next
    await this.advanceToNextPair();
  }

  /**
   * Skip to previous pair.
   */
  async skipBack(): Promise<void> {
    if (!this.state.isPlaying || this.playHistory.length < 2) return;

    // Get previous pair
    this.playHistory.pop(); // Remove current
    const prevPair = this.playHistory.pop(); // Get previous
    if (!prevPair) return;

    // Stop current
    this.clearScheduled();
    this.currentSources.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    this.currentSources = [];

    // Move back in progression
    this.progressIndex = (this.progressIndex - 1 + this.progression.length) % this.progression.length;

    this.updateState({
      currentPair: prevPair,
      key: prevPair.key,
      tempo: prevPair.tempo,
      progressIndex: this.progressIndex,
    });

    // Play previous pair
    await this.playPair(prevPair);
  }

  /**
   * Recalculate Hamiltonian path and regenerate progression from user's chosen key/tempo.
   * Called when user changes key or tempo.
   */
  private recalculateHamiltonianPath(startKey: Key, startTempo: Tempo): void {
    // Get unplayed songs
    const unplayedSongs = this.songs.filter(song => !this.playedSongIds.has(song.id));

    // If we've played most songs, reset and use all songs
    if (unplayedSongs.length < 20) {
      console.log('🔄 Most songs played - resetting Hamiltonian path with all songs');
      this.playedSongIds.clear();
      this.hamiltonianPath = this.shuffleSongs([...this.songs]);
    } else {
      console.log(`🔄 Recalculating Hamiltonian path with ${unplayedSongs.length} unplayed songs`);
      this.hamiltonianPath = this.shuffleSongs(unplayedSongs);
    }

    // Reset path indexes
    for (const tempo of ALL_TEMPOS) {
      this.pathIndexesByTempo.set(tempo, 0);
    }

    // Regenerate progression starting from the user's chosen key/tempo
    // This ensures the formula continues properly: 10 keys at tempo, then switch
    this.progression = this.generateProgressionFromPoint(startKey, startTempo);
    this.progressIndex = 0; // Start from beginning of new progression
  }

  /**
   * Generate progression starting from a specific key and tempo.
   * Walks through all 10 keys at the starting tempo, then switches to next tempo.
   * Key order: startKey → startKey+1 → ... → 10 → 1 → ... → startKey-1
   * Tempo order: startTempo → next tempo → next tempo → back to startTempo
   */
  private generateProgressionFromPoint(startKey: Key, startTempo: Tempo): ProgressionEntry[] {
    const progression: ProgressionEntry[] = [];
    const KEYS_TO_USE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as Key[];

    // Find starting positions
    const startKeyIndex = KEYS_TO_USE.indexOf(startKey);
    const startTempoIndex = ALL_TEMPOS.indexOf(startTempo);

    // Generate enough entries for continuous playback (10 tempo cycles)
    for (let cycle = 0; cycle < 10; cycle++) {
      // Cycle through tempos starting from startTempo
      for (let tempoOffset = 0; tempoOffset < ALL_TEMPOS.length; tempoOffset++) {
        const tempo = ALL_TEMPOS[(startTempoIndex + tempoOffset) % ALL_TEMPOS.length];

        // For each tempo, walk through all 10 keys starting from startKey
        for (let keyOffset = 0; keyOffset < KEYS_TO_USE.length; keyOffset++) {
          const key = KEYS_TO_USE[(startKeyIndex + keyOffset) % KEYS_TO_USE.length];

          progression.push({ key, tempo });
        }
      }
    }

    return progression;
  }

  /**
   * Change key (applies immediately - recalculates path with unplayed songs).
   */
  setKey(key: Key): void {
    if (!this.state.isPlaying) {
      this.updateState({ key });
      return;
    }

    // Recalculate Hamiltonian path starting from this key
    const currentTempo = this.state.tempo;
    this.recalculateHamiltonianPath(key, currentTempo);

    // Prepare new next pair - avoid artists from current pair
    const nextEntry = this.progression[(this.progressIndex + 1) % this.progression.length];
    const avoidArtists = this.state.currentPair
      ? [this.state.currentPair.track1.song.artist, this.state.currentPair.track2.song.artist]
      : [];
    const song1 = this.getNextSong(nextEntry.tempo, avoidArtists);
    const song2 = this.getNextSong(nextEntry.tempo, [...avoidArtists, song1.artist]);
    const newNext = this.createTrackPair(song1, song2, nextEntry.key, nextEntry.tempo);

    this.updateState({
      key,
      nextPair: newNext,
      progressIndex: this.progressIndex
    });

    // Preload the new next pair
    void this.preloadNextPair(newNext);
  }

  /**
   * Change tempo (applies immediately - recalculates path with unplayed songs).
   */
  setTempo(tempo: Tempo): void {
    if (!this.state.isPlaying) {
      this.updateState({ tempo });
      return;
    }

    // Recalculate Hamiltonian path starting from this tempo
    const currentKey = this.state.key;
    this.recalculateHamiltonianPath(currentKey, tempo);

    // Prepare new next pair - avoid artists from current pair
    const nextEntry = this.progression[(this.progressIndex + 1) % this.progression.length];
    const avoidArtists = this.state.currentPair
      ? [this.state.currentPair.track1.song.artist, this.state.currentPair.track2.song.artist]
      : [];
    const song1 = this.getNextSong(nextEntry.tempo, avoidArtists);
    const song2 = this.getNextSong(nextEntry.tempo, [...avoidArtists, song1.artist]);
    const newNext = this.createTrackPair(song1, song2, nextEntry.key, nextEntry.tempo);

    this.updateState({
      tempo,
      nextPair: newNext,
      progressIndex: this.progressIndex
    });

    // Preload the new next pair
    void this.preloadNextPair(newNext);
  }

  getState(): PlayerState {
    return { ...this.state };
  }

  /**
   * Get the full Hamiltonian progression as a playlist.
   * Returns the first N pairs in order.
   */
  getPlaylist(count: number = 50): Array<{ key: Key; tempo: Tempo; songs: [Song, Song] }> {
    const playlist: Array<{ key: Key; tempo: Tempo; songs: [Song, Song] }> = [];
    // Create temporary indexes to simulate the progression without affecting real playback
    const tempPathIndexes = new Map<Tempo, number>();
    for (const tempo of ALL_TEMPOS) {
      tempPathIndexes.set(tempo, this.pathIndexesByTempo.get(tempo) || 0);
    }

    // Helper to get next song at tempo without modifying real state
    const getNextSongForPlaylist = (tempo: Tempo): Song | null => {
      const startIndex = tempPathIndexes.get(tempo) || 0;
      let searchIndex = startIndex;
      let wrapped = false;

      while (true) {
        if (searchIndex >= this.hamiltonianPath.length) {
          searchIndex = 0;
          wrapped = true;
        }

        if (wrapped && searchIndex >= startIndex) {
          // Would need to reshuffle - just return null
          return null;
        }

        const song = this.hamiltonianPath[searchIndex];
        if (song.bpm === tempo) {
          tempPathIndexes.set(tempo, searchIndex + 1);
          return song;
        }

        searchIndex++;
      }
    };

    for (let i = 0; i < Math.min(count, this.progression.length); i++) {
      const entry = this.progression[i];
      const song1 = getNextSongForPlaylist(entry.tempo);
      const song2 = getNextSongForPlaylist(entry.tempo);

      if (song1 && song2) {
        playlist.push({
          key: entry.key,
          tempo: entry.tempo,
          songs: [song1, song2],
        });
      } else {
        // Can't generate more pairs without reshuffle
        break;
      }
    }

    return playlist;
  }
}
