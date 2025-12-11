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

import type { Song, Key, Tempo, TrackType } from '@/music/types';
import { BEAT_COUNTS, ALL_TEMPOS } from '@/music/types';
import { MUSIC_BASE_URL } from '../config';
import { EnhancedRandom } from '@/random/EnhancedRandom';
import { encodeWAV } from '@/utils/wavEncoder';

/**
 * Calculate the duration in seconds for a track at a given tempo.
 */
function calculateTrackDuration(tempo: Tempo, type: TrackType): number {
  const secondsPerBeat = 60 / tempo;
  const beats = BEAT_COUNTS[type];
  return beats * secondsPerBeat;
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
  eightZeroEightMode: boolean; // 808 Mode - frequency split & rhythmic recombination
  isRecordingArmed: boolean; // Recording armed (waiting for playback to start)
  isRecordingActive: boolean; // Recording actively capturing audio
  recordingDuration: number; // Recording duration in seconds
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
  private mannieFreshMode: boolean = true; // Enable hidden tracks that alternate every 4 bars
  private mannieFreshVolume: number = 0.66; // Volume for MF tracks (0-1), default 66%
  private currentHiddenTrack: 3 | 4 = 3; // Which hidden track is currently playing (3 or 4)
  private hiddenTrackSwitchInterval: number | null = null; // Interval for switching hidden tracks
  private hiddenTrackSwitchTimeout: number | null = null; // Timeout that sets up the interval
  private playedSongIds: Set<number> = new Set(); // Track which songs have been played
  private playedPairs: Set<string> = new Set(); // Track which pairs have been played (never repeat)
  private pendingLoads: Map<string, Promise<AudioBuffer>> = new Map(); // Track in-progress loads to prevent duplicates
  private recentArtists: string[] = []; // Track recent artists for diversity
  private recentSongs: Song[] = []; // Track recently played songs
  private scheduledPairsCount: number = 0; // Track how many pairs are scheduled ahead
  private readonly MAX_SCHEDULED_PAIRS = 1; // Limit scheduling to prevent memory issues on iOS
  private qrng: EnhancedRandom; // Enhanced random number generator with chaotic behavior
  private tempoPairCounts: Map<Tempo, number> = new Map(); // Weighted pair counts per tempo for equal distribution

  // 808 Mode - Frequency splitting for deconstructed beats
  private eightZeroEightMode: boolean = false;
  private track1Filters: { low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode } | null = null;
  private track2Filters: { low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode } | null = null;
  private track3Filters: { low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode } | null = null;
  private track4Filters: { low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode } | null = null;
  private rhythmicGainNodes: GainNode[] = []; // For rhythmic gating in 808 mode
  private rhythmicPatternInterval: number | null = null; // Interval for rhythmic pattern automation
  private eightZeroEightCompressor: DynamicsCompressorNode | null = null; // Dedicated compressor for 808 mode
  private eightZeroEightMakeupGain: GainNode | null = null; // Makeup gain to compensate for frequency splitting

  // Recording (lossless WAV)
  private mediaStreamDestination: MediaStreamAudioDestinationNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private recordedBuffers: Float32Array[] = [];
  private recordingStartTime: number = 0;
  private recordingTimer: number | null = null;
  private isRecordingPaused: boolean = false;

  // Pre-computed playlist for URL-based sharing
  private precomputedPlaylist: TrackPair[] | null = null;
  private precomputedIndex: number = 0;

  constructor(songs: Song[], initialKey?: Key, initialTempo?: Tempo) {
    this.songs = songs;
    this.qrng = new EnhancedRandom();
    this.hamiltonianPath = [...songs]; // Will be shuffled in init()

    // Initialize path indexes for each tempo
    for (const tempo of ALL_TEMPOS) {
      this.pathIndexesByTempo.set(tempo, 0);
    }

    // Calculate weighted pair counts for each tempo to ensure equal song distribution
    // More songs at a tempo = more pairs played at that tempo
    const songCountsByTempo = new Map<Tempo, number>();
    for (const tempo of ALL_TEMPOS) {
      const count = songs.filter(s => s.bpm === tempo).length;
      songCountsByTempo.set(tempo, count);
    }

    // Find minimum song count to use as base
    const minSongCount = Math.min(...Array.from(songCountsByTempo.values()));
    const basePairCount = 10; // Base number of pairs for tempo with fewest songs

    // Calculate proportional pair counts
    for (const tempo of ALL_TEMPOS) {
      const songCount = songCountsByTempo.get(tempo) || 1;
      const pairCount = Math.round(basePairCount * (songCount / minSongCount));
      this.tempoPairCounts.set(tempo, pairCount);
    }

    // Store initial key/tempo for use in init
    const startKey = initialKey ?? 1 as Key;
    const startTempo = initialTempo ?? 84;

    // Generate progression starting from the chosen key/tempo
    this.progression = this.generateProgressionFromPoint(startKey, startTempo);
    this.progressIndex = 0;

    const currentEntry = this.progression[this.progressIndex];
    if (!currentEntry) {
      throw new Error('Failed to generate progression - no entries available');
    }

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
      mannieFreshMode: true,
      activeHiddenTrack: 3,
      eightZeroEightMode: false,
      isRecordingArmed: false,
      isRecordingActive: false,
      recordingDuration: 0,
    };
  }

  /**
   * Async initialization to shuffle songs with quantum randomness.
   * Also selects random starting key and tempo using quantum randomness.
   * Call this after construction and await it before using the player.
   */
  async init(): Promise<void> {
    // Shuffle the Hamiltonian path with true randomness
    this.hamiltonianPath = await this.shuffleSongs([...this.songs]);

    // Select random starting key (1-10) and tempo using quantum randomness
    const VALID_KEYS: Key[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const randomKey = await this.qrng.getChoice(VALID_KEYS);
    const randomTempo = await this.qrng.getChoice(ALL_TEMPOS);

    // Regenerate progression from random starting point
    this.progression = this.generateProgressionFromPoint(randomKey, randomTempo);
    this.progressIndex = 0;

    const currentEntry = this.progression[this.progressIndex];
    if (!currentEntry) {
      throw new Error('Failed to generate progression - no entries available');
    }

    // Update state with random starting point
    this.updateState({
      key: currentEntry.key,
      tempo: currentEntry.tempo,
      progressIndex: this.progressIndex,
    });
  }

  /**
   * Update songs list (e.g., when user changes settings).
   * Re-initializes the player with the new song list.
   */
  async updateSongs(newSongs: Song[]): Promise<void> {
    if (newSongs.length === 0) {
      return;
    }

    // Stop current playback
    this.stop();

    // Update songs
    this.songs = newSongs;

    // Reset state
    this.playedSongIds.clear();
    this.playedPairs.clear();
    this.recentArtists = [];
    this.recentSongs = [];

    // Re-initialize with new songs
    await this.init();
  }

  /**
   * Shuffle songs using quantum randomness for true unpredictability.
   */
  private async shuffleSongs(songs: Song[]): Promise<Song[]> {
    return await this.qrng.shuffle(songs);
  }

  /**
   * Check if two artists match (including substring matching).
   * E.g., "Jay-Z" matches "Jay-Z feat. Beyoncé"
   */
  private artistsMatch(artist1: string, artist2: string): boolean {
    const a1 = artist1.toLowerCase();
    const a2 = artist2.toLowerCase();
    return a1.includes(a2) || a2.includes(a1);
  }

  /**
   * Create a unique pair ID for tracking.
   */
  private getPairId(song1: Song, song2: Song): string {
    const [id1, id2] = [song1.id, song2.id].sort((a, b) => a - b);
    return `${id1}-${id2}`;
  }

  /**
   * Check if a pair has been played before.
   */
  private isPairPlayed(song1: Song, song2: Song): boolean {
    return this.playedPairs.has(this.getPairId(song1, song2));
  }

  /**
   * Mark a pair as played.
   */
  private markPairPlayed(song1: Song, song2: Song): void {
    this.playedPairs.add(this.getPairId(song1, song2));
  }

  /**
   * Score a candidate song based on multiple factors.
   * Higher score = better choice.
   */
  private scoreSong(song: Song, tempo: Tempo, key: Key, partnerSong: Song | null, avoidArtists: string[]): number {
    let score = 100;

    // Tempo compatibility (preference for matching, but allow stretches for variety)
    if (song.bpm === tempo) {
      score += 60; // Strong bonus for exact tempo match
    } else {
      // Allow different tempos but with penalties based on distance
      const tempoDiff = Math.abs(song.bpm - tempo);
      if (tempoDiff <= 6) {
        score += 20; // Close tempo (within ~6 BPM)
      } else if (tempoDiff <= 12) {
        score -= 10; // Moderate stretch
      } else if (tempoDiff <= 18) {
        score -= 30; // Bigger stretch
      } else {
        score -= 50; // Very distant tempo (still allowed for variety)
      }
    }

    // Key compatibility with multiple "chord hitting" approaches for maximum diversity
    // Like Chordant: randomly use different harmonic relationships
    const harmonicApproach = Math.floor(Math.random() * 6); // 6 different approaches
    const keyDiff = Math.abs(song.key - key);
    const circularDiff = Math.min(keyDiff, 12 - keyDiff);

    if (song.key === key) {
      score += 50; // Perfect key match (always valid)
    } else {
      switch (harmonicApproach) {
        case 0: // Traditional: circle of fifths
          if (circularDiff === 5 || circularDiff === 7) score += 30; // Perfect fifth/fourth
          else if (circularDiff === 3 || circularDiff === 4) score += 20; // Relative minor/major
          else if (circularDiff === 2) score += 10; // Whole step
          else score -= circularDiff * 3;
          break;

        case 1: // Pentatonic: focus on 2nd, 5th, 9th (whole tone relationships)
          if (circularDiff === 2 || circularDiff === 5 || circularDiff === 9) score += 35; // Pentatonic intervals
          else if (circularDiff === 7) score += 25; // Fifth
          else score -= circularDiff * 4;
          break;

        case 2: // Modal: emphasize 2nd, 4th, 6th (modal interchange)
          if (circularDiff === 2 || circularDiff === 4 || circularDiff === 6) score += 30; // Modal shifts
          else if (circularDiff === 3 || circularDiff === 5) score += 20;
          else score -= circularDiff * 3;
          break;

        case 3: // Parallel/Modal: same root different mode (tritone)
          if (circularDiff === 6) score += 35; // Tritone substitution (jazz harmony)
          else if (circularDiff === 3 || circularDiff === 9) score += 25; // Minor third / major sixth
          else score -= circularDiff * 4;
          break;

        case 4: // Extended harmony: 6ths, 9ths, 11ths
          if (circularDiff === 8 || circularDiff === 9) score += 30; // Major 6th / Major 9th
          else if (circularDiff === 2 || circularDiff === 11) score += 25; // 2nd / 11th
          else score -= circularDiff * 3;
          break;

        case 5: // Chromatic/Adjacent: stepwise motion
          if (circularDiff === 1) score += 35; // Semitone (chromatic approach)
          else if (circularDiff === 2) score += 30; // Whole tone
          else if (circularDiff === 5 || circularDiff === 7) score += 20; // Falls back to fifths
          else score -= circularDiff * 3;
          break;
      }
    }

    // Artist diversity - penalize if artist matches any in avoid list
    for (const avoidArtist of avoidArtists) {
      if (this.artistsMatch(song.artist, avoidArtist)) {
        score -= 80; // Heavy penalty for artist repetition
      }
    }

    // Partner song checks (if selecting song2)
    if (partnerSong) {
      // Never pair with same artist
      if (this.artistsMatch(song.artist, partnerSong.artist)) {
        return -1000; // Invalid
      }

      // Never repeat a pair
      if (this.isPairPlayed(song, partnerSong)) {
        return -1000; // Invalid
      }

      // Prefer different artists (bonus for diversity)
      score += 30;
    }

    // Recency penalty - prefer songs not played recently
    const recentIndex = this.recentSongs.findIndex(s => s.id === song.id);
    if (recentIndex !== -1) {
      // More recent = bigger penalty
      const recencyPenalty = Math.max(0, 50 - recentIndex * 2);
      score -= recencyPenalty;
    }

    // MASSIVE bonus for songs not played yet (ensures Hamiltonian path behavior)
    // This bonus is large enough to overcome tempo/key mismatches and random variance
    // Only played songs should be selected when no unplayed songs meet the constraints
    if (!this.playedSongIds.has(song.id)) {
      score += 200;
    }

    // Add variety factors to break ties and create more interesting selections:
    // Brian Eno style: chaos within constraints

    // INCREASED random variance for maximum chaos and unpredictability (0-80 points)
    // Creates significant differentiation even among "identical" candidates
    // High variance ensures songs aren't predictably chosen based on ID or other biases
    const randomVariance = Math.random() * 80;
    score += randomVariance;

    return score;
  }

  /**
   * Get the next song using sophisticated selection algorithm.
   * Takes time to find the perfect match considering:
   * - Key/tempo constraints
   * - No repeated pairs
   * - Artist diversity
   * - Recency
   * Uses quantum randomness for final selection from top candidates.
   */
  private async getNextSongSmart(tempo: Tempo, key: Key, partnerSong: Song | null = null, avoidArtists: string[] = [], avoidSongIds: number[] = []): Promise<Song> {
    // HAMILTONIAN PATH: Prioritize unplayed songs to ensure we cycle through all songs
    const unplayedSongs = this.songs.filter(song => !this.playedSongIds.has(song.id) && !avoidSongIds.includes(song.id));
    const shouldResetPlayedSongs = unplayedSongs.length < 20;

    // STRICT TEMPO MATCHING: Only consider songs at the exact target tempo
    // This prevents tempo mismatches (e.g., 84 BPM song with 94 BPM songs)
    const unplayedAtTempo = unplayedSongs.filter(song => song.bpm === tempo);
    const allSongsAtTempo = this.songs.filter(song => song.bpm === tempo && !avoidSongIds.includes(song.id));

    // Try unplayed songs at correct tempo first (proper Hamiltonian behavior)
    let candidates = unplayedAtTempo.length > 0 ? unplayedAtTempo : allSongsAtTempo;

    // Score all candidates
    const scored = candidates
      .map(song => ({
        song,
        score: this.scoreSong(song, tempo, key, partnerSong, avoidArtists)
      }))
      .filter(item => item.score > -1000) // Remove invalid candidates
      .sort((a, b) => b.score - a.score); // Highest score first

    if (scored.length === 0) {
      // No valid candidates - try fallback strategies
      // If we were only considering unplayed songs at tempo, expand to ALL songs at tempo
      if (candidates === unplayedAtTempo && unplayedAtTempo.length > 0) {
        candidates = allSongsAtTempo;
        const allScored = candidates
          .map(song => ({
            song,
            score: this.scoreSong(song, tempo, key, partnerSong, avoidArtists)
          }))
          .filter(item => item.score > -1000)
          .sort((a, b) => b.score - a.score);

        if (allScored.length > 0) {
          const topCandidates = allScored.slice(0, Math.min(20, allScored.length));
          const selected = await this.qrng.getChoice(topCandidates);
          return selected.song;
        }
      }

      // Try without artist avoidance
      const relaxed = candidates
        .map(song => ({
          song,
          score: this.scoreSong(song, tempo, key, partnerSong, []) // Remove artist avoidance
        }))
        .filter(item => item.score > -1000)
        .sort((a, b) => b.score - a.score);

      if (relaxed.length === 0) {
        // Last resort: just pick any song
        return candidates[0]!;
      }

      // Pick from top 20 relaxed candidates for more variety
      const topRelaxed = relaxed.slice(0, Math.min(20, relaxed.length));
      const selected = await this.qrng.getChoice(topRelaxed);
      return selected.song;
    }

    // Select from top 20 candidates using quantum randomness for maximum variety
    const topCandidates = scored.slice(0, Math.min(20, scored.length));
    const selected = await this.qrng.getChoice(topCandidates);

    // Auto-reset played songs if we're running low on unplayed songs
    // This ensures continuous Hamiltonian cycling through all songs
    if (shouldResetPlayedSongs && this.playedSongIds.size > 0) {
      this.playedSongIds.clear();
      // Also reset played pairs to allow fresh combinations
      this.playedPairs.clear();
    }

    return selected.song;
  }

  /**
   * OLD METHOD: Get the next song from the Hamiltonian path at the specified tempo.
   * Searches forward in the path for a song at the required tempo.
   * Reshuffles the entire path when we've exhausted all tempos.
   * Optionally avoids songs by specified artists for variety.
   *
   * NOTE: This is kept for backward compatibility but not used anymore.
   */
  private getNextSong(tempo: Tempo, avoidArtists: string[] = []): Song {
    // Safety check: ensure we have songs and a path
    if (!this.hamiltonianPath || this.hamiltonianPath.length === 0) {
      this.hamiltonianPath = [...this.songs];
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

        this.hamiltonianPath = [...this.songs]; // Use unshuffled songs as emergency fallback
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

    this.hamiltonianPath = [...this.songs]; // Use unshuffled songs as emergency fallback
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

    // Use .wav on localhost for higher quality, .mp3 in production
    const isLocalhost = typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    const extension = isLocalhost ? 'wav' : 'mp3';

    return {
      song,
      key,
      tempo,
      introUrl: `${MUSIC_BASE_URL}${songId}-lead.${extension}`,
      mainUrl: `${MUSIC_BASE_URL}${songId}-body.${extension}`,
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

      // Create MediaStreamDestination for recording
      this.mediaStreamDestination = this.audioContext.createMediaStreamDestination();
      this.masterCompressor.connect(this.mediaStreamDestination);

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
  private updateHiddenTrackGains(fadeTime: number = 0.015): void {
    if (!this.track3Gain || !this.track4Gain || !this.audioContext) return;

    const now = this.audioContext.currentTime;

    if (this.eightZeroEightMode) {
      // In 808 mode, all tracks play at full volume (routing is handled by 808 processing)
      this.track3Gain.gain.setTargetAtTime(1.0, now, fadeTime);
      this.track4Gain.gain.setTargetAtTime(1.0, now, fadeTime);
    } else if (this.mannieFreshMode) {
      // Apply volume setting to the active hidden track, silent for the inactive one
      const gain3 = this.currentHiddenTrack === 3 ? this.mannieFreshVolume : 0;
      const gain4 = this.currentHiddenTrack === 4 ? this.mannieFreshVolume : 0;

      this.track3Gain.gain.setTargetAtTime(gain3, now, fadeTime);
      this.track4Gain.gain.setTargetAtTime(gain4, now, fadeTime);
    } else {
      // Silent when both modes are off
      this.track3Gain.gain.setTargetAtTime(0, now, fadeTime);
      this.track4Gain.gain.setTargetAtTime(0, now, fadeTime);
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
   * Set up MF mode switches for the current pair.
   * Called when a scheduled pair becomes current.
   */
  private setupMFSwitchesForCurrentPair(pair: TrackPair, mainStartTime: number): void {
    if (!this.audioContext) return;

    // ALWAYS clear any existing switches
    if (this.hiddenTrackSwitchTimeout !== null) {
      clearTimeout(this.hiddenTrackSwitchTimeout);
      this.hiddenTrackSwitchTimeout = null;
    }
    if (this.hiddenTrackSwitchInterval !== null) {
      clearInterval(this.hiddenTrackSwitchInterval);
      this.hiddenTrackSwitchInterval = null;
    }

    // Reset hidden track state and set gains
    this.currentHiddenTrack = 3;
    this.updateHiddenTrackGains();

    // Start switching at main section start
    const firstSwitchTime = mainStartTime;

    // Recursive function to schedule switches - ALWAYS recalculates duration from current pair
    const scheduleNextSwitch = (nextSwitchTime: number): void => {
      if (!this.audioContext) return;

      const now = this.audioContext.currentTime;
      const delay = Math.max(0, (nextSwitchTime - now) * 1000);

      this.hiddenTrackSwitchTimeout = window.setTimeout(() => {
        // Only switch if MF mode is ON and player is actively playing
        if (!this.mannieFreshMode || !this.state.isPlaying) {
          return;
        }

        // Get the CURRENT pair's tempo (not captured tempo)
        const currentPairTempo = this.state.currentPair?.tempo || pair.tempo;
        const currentFourBarDuration = this.calculate4BarDuration(currentPairTempo);

        // Alternate between track 3 and 4
        this.currentHiddenTrack = this.currentHiddenTrack === 3 ? 4 : 3;
        this.updateHiddenTrackGains();

        // Update state to show active track in UI
        this.updateState({
          activeHiddenTrack: this.mannieFreshMode ? this.currentHiddenTrack : null,
        });

        // Schedule next switch using CURRENT pair's tempo, not captured tempo
        const nextTime = nextSwitchTime + currentFourBarDuration;
        scheduleNextSwitch(nextTime);
      }, delay);
    };

    // Start the switching chain at main section start
    scheduleNextSwitch(firstSwitchTime);
  }

  /**
   * Get a musically related key using various harmonic relationships.
   * Uses circle of fifths, parallel modes, relative keys, and other theory.
   */
  private async getMusicallyRelatedKey(baseKey: Key): Promise<Key> {
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

    // Pick a random relationship using quantum randomness
    const relationship = await this.qrng.getChoice(relationships);

    // Calculate new key (mod 12 for octave wrap, +1 because keys are 1-indexed)
    let newKey = ((baseKey - 1 + relationship) % 12);
    if (newKey < 0) newKey += 12;

    // Ensure we stay within the valid key range (1-10)
    return (Math.max(1, Math.min(10, newKey + 1))) as Key;
  }

  /**
   * Toggle Mannie Fresh mode on/off.
   * When enabled, two hidden tracks play at full volume, alternating every 8 bars.
   * Mutually exclusive with 808 mode.
   */
  toggleMannieFreshMode(): void {
    // If turning on MF mode, turn off 808 mode
    if (!this.mannieFreshMode && this.eightZeroEightMode) {
      this.toggle808Mode();
    }

    this.mannieFreshMode = !this.mannieFreshMode;
    // Use 0.8 second fade for smooth transition
    this.updateHiddenTrackGains(0.8);
    this.updateState({
      mannieFreshMode: this.mannieFreshMode,
      activeHiddenTrack: this.mannieFreshMode ? this.currentHiddenTrack : null,
    });

    // Note: Switching is handled by the beat-synced interval set up when the pair starts.
    // No need to create a new interval here - just let the existing one handle it.
  }

  /**
   * Toggle 808 mode on/off.
   * When enabled, the four tracks are frequency-split and rhythmically recombined
   * to create a new deconstructed beat that sounds cohesive but entirely different.
   * Mutually exclusive with Mannie Fresh mode.
   */
  toggle808Mode(): void {
    // If turning on 808 mode, turn off MF mode
    if (!this.eightZeroEightMode && this.mannieFreshMode) {
      this.toggleMannieFreshMode();
    }

    this.eightZeroEightMode = !this.eightZeroEightMode;

    if (this.eightZeroEightMode) {
      // Use 0.8 second fade for smooth transition
      this.updateHiddenTrackGains(0.8); // Enable tracks 3 & 4
      this.apply808Processing();
      this.startRhythmicGating();
    } else {
      this.remove808Processing();
      this.stopRhythmicGating();
      // Use 0.8 second fade for smooth transition
      this.updateHiddenTrackGains(0.8); // Disable tracks 3 & 4
    }

    this.updateState({
      eightZeroEightMode: this.eightZeroEightMode,
    });
  }

  /**
   * Apply 808 mode frequency splitting and routing.
   * Splits each track into LOW/MID/HIGH frequency bands and routes them
   * to create a deconstructed beat.
   */
  private apply808Processing(): void {
    if (!this.audioContext || !this.track1Gain || !this.track2Gain || !this.track3Gain || !this.track4Gain) {
      return;
    }

    // Create filter banks for each track
    // Each track gets: LOW (20-250Hz), MID (250-3000Hz), HIGH (3000-20000Hz)
    this.track1Filters = this.createFilterBank();
    this.track2Filters = this.createFilterBank();
    this.track3Filters = this.createFilterBank();
    this.track4Filters = this.createFilterBank();

    // Rewire the audio graph with 808 processing
    this.reconnectWith808Processing();
  }

  /**
   * Remove 808 mode processing and restore normal routing.
   */
  private remove808Processing(): void {
    // Disconnect and clear rhythmic gain nodes
    for (const node of this.rhythmicGainNodes) {
      if (node) {
        try {
          node.disconnect();
        } catch (e) {
          // Already disconnected
        }
      }
    }
    this.rhythmicGainNodes = [];

    // Disconnect and clear 808 compressor and makeup gain
    if (this.eightZeroEightCompressor) {
      try {
        this.eightZeroEightCompressor.disconnect();
      } catch (e) {
        // Already disconnected
      }
      this.eightZeroEightCompressor = null;
    }

    if (this.eightZeroEightMakeupGain) {
      try {
        this.eightZeroEightMakeupGain.disconnect();
      } catch (e) {
        // Already disconnected
      }
      this.eightZeroEightMakeupGain = null;
    }

    // Clear filter banks
    this.track1Filters = null;
    this.track2Filters = null;
    this.track3Filters = null;
    this.track4Filters = null;

    // Restore normal routing: disconnect gain nodes and reconnect to master
    if (this.track1Gain && this.track2Gain && this.track3Gain && this.track4Gain && this.masterCompressor) {
      try {
        this.track1Gain.disconnect();
        this.track2Gain.disconnect();
        this.track3Gain.disconnect();
        this.track4Gain.disconnect();
      } catch (e) {
        // Already disconnected
      }

      // Reconnect directly to master compressor (normal routing)
      this.track1Gain.connect(this.masterCompressor);
      this.track2Gain.connect(this.masterCompressor);
      this.track3Gain.connect(this.masterCompressor);
      this.track4Gain.connect(this.masterCompressor);
    }
  }

  /**
   * Create a filter bank with LOW/MID/HIGH bands.
   */
  private createFilterBank(): { low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode } {
    if (!this.audioContext) {
      throw new Error('AudioContext not initialized');
    }

    // LOW: 20-250Hz (bass, kick, 808)
    const lowFilter = this.audioContext.createBiquadFilter();
    lowFilter.type = 'lowpass';
    lowFilter.frequency.setValueAtTime(250, this.audioContext.currentTime);
    lowFilter.Q.setValueAtTime(1, this.audioContext.currentTime);

    // MID: 250-3000Hz (snare, melody, vocals)
    const midFilter = this.audioContext.createBiquadFilter();
    midFilter.type = 'bandpass';
    midFilter.frequency.setValueAtTime(1000, this.audioContext.currentTime); // Center freq
    midFilter.Q.setValueAtTime(0.7, this.audioContext.currentTime); // Wider band

    // HIGH: 3000-20000Hz (hi-hats, cymbals, air)
    const highFilter = this.audioContext.createBiquadFilter();
    highFilter.type = 'highpass';
    highFilter.frequency.setValueAtTime(3000, this.audioContext.currentTime);
    highFilter.Q.setValueAtTime(1, this.audioContext.currentTime);

    return { low: lowFilter, mid: midFilter, high: highFilter };
  }

  /**
   * Reconnect audio sources with 808 processing.
   * This creates a new beat by taking different frequency bands from different tracks.
   *
   * 808 Mix Strategy:
   * - Track 1 LOW → Bass/kick foundation
   * - Track 2 MID → Melody/snare elements
   * - Track 3 HIGH → Hi-hats/cymbals/texture
   * - Track 4 LOW → Additional bass texture (at reduced volume)
   */
  private reconnectWith808Processing(): void {
    if (!this.audioContext || !this.masterCompressor) return;
    if (!this.track1Filters || !this.track2Filters || !this.track3Filters || !this.track4Filters) return;
    if (!this.track1Gain || !this.track2Gain || !this.track3Gain || !this.track4Gain) return;

    // Disconnect gain nodes from master (we'll reconnect filtered paths)
    try {
      this.track1Gain.disconnect();
      this.track2Gain.disconnect();
      this.track3Gain.disconnect();
      this.track4Gain.disconnect();
    } catch (e) {
      // Already disconnected, that's fine
    }

    // Create mix buses for the deconstructed beat
    const lowBus = this.audioContext.createGain();
    const midBus = this.audioContext.createGain();
    const highBus = this.audioContext.createGain();

    // Set bus levels - boosted for louder output
    lowBus.gain.setValueAtTime(1.3, this.audioContext.currentTime); // Strong bass
    midBus.gain.setValueAtTime(1.2, this.audioContext.currentTime); // Strong mids
    highBus.gain.setValueAtTime(1.1, this.audioContext.currentTime); // Boosted highs

    // Create dedicated 808 compressor for aggressive compression
    this.eightZeroEightCompressor = this.audioContext.createDynamicsCompressor();
    this.eightZeroEightCompressor.threshold.setValueAtTime(-24, this.audioContext.currentTime); // Lower threshold
    this.eightZeroEightCompressor.knee.setValueAtTime(30, this.audioContext.currentTime); // Soft knee
    this.eightZeroEightCompressor.ratio.setValueAtTime(12, this.audioContext.currentTime); // Aggressive ratio
    this.eightZeroEightCompressor.attack.setValueAtTime(0.001, this.audioContext.currentTime); // Fast attack
    this.eightZeroEightCompressor.release.setValueAtTime(0.1, this.audioContext.currentTime); // Quick release

    // Create makeup gain to compensate for frequency splitting losses
    this.eightZeroEightMakeupGain = this.audioContext.createGain();
    this.eightZeroEightMakeupGain.gain.setValueAtTime(2.5, this.audioContext.currentTime); // +8dB makeup gain

    // Route: Track 1's bass + Track 4's bass → LOW BUS
    this.track1Gain.connect(this.track1Filters.low);
    this.track1Filters.low.connect(lowBus);

    // Track 4 bass (blended at lower volume for texture)
    const track4LowGain = this.audioContext.createGain();
    track4LowGain.gain.setValueAtTime(0.5, this.audioContext.currentTime);
    this.track4Gain.connect(this.track4Filters.low);
    this.track4Filters.low.connect(track4LowGain);
    track4LowGain.connect(lowBus);

    // Route: Track 2's mids → MID BUS
    this.track2Gain.connect(this.track2Filters.mid);
    this.track2Filters.mid.connect(midBus);

    // Route: Track 3's highs → HIGH BUS
    this.track3Gain.connect(this.track3Filters.high);
    this.track3Filters.high.connect(highBus);

    // Connect all buses through dedicated 808 compressor → makeup gain → master compressor
    lowBus.connect(this.eightZeroEightCompressor);
    midBus.connect(this.eightZeroEightCompressor);
    highBus.connect(this.eightZeroEightCompressor);

    this.eightZeroEightCompressor.connect(this.eightZeroEightMakeupGain);
    this.eightZeroEightMakeupGain.connect(this.masterCompressor);

    // Store references for cleanup
    this.rhythmicGainNodes = [lowBus, midBus, highBus];
  }

  /**
   * Start rhythmic gating patterns for 808 mode.
   * Creates pulsing patterns that bring elements in/out rhythmically.
   */
  private startRhythmicGating(): void {
    if (!this.audioContext) return;

    const tempo = this.state.tempo;
    const beatDuration = 60 / tempo; // Duration of one beat in seconds

    // Stop any existing pattern
    this.stopRhythmicGating();

    let patternStep = 0;

    // Rhythmic pattern automation
    const updatePattern = (): void => {
      if (!this.audioContext || this.rhythmicGainNodes.length === 0) return;

      const [lowBus, midBus, highBus] = this.rhythmicGainNodes;
      if (!lowBus || !midBus || !highBus) return;

      const now = this.audioContext.currentTime;
      const rampTime = beatDuration * 0.25; // Smooth ramps

      // Pattern: 16-step sequence (4 bars)
      // LOW: Steady pulse on 1 and 3 of each bar
      // MID: Syncopated - on 2 and 4, plus 16th note fills
      // HIGH: Constant with subtle ducking

      const beatInPattern = patternStep % 16;

      // LOW pattern (kicks on 1, 5, 9, 13)
      if (beatInPattern % 4 === 0) {
        lowBus.gain.setTargetAtTime(1.0, now, rampTime);
      } else {
        lowBus.gain.setTargetAtTime(0.6, now, rampTime);
      }

      // MID pattern (snares/claps on 4, 8, 12, 16)
      if (beatInPattern === 3 || beatInPattern === 7 || beatInPattern === 11 || beatInPattern === 15) {
        midBus.gain.setTargetAtTime(1.0, now, rampTime);
      } else {
        midBus.gain.setTargetAtTime(0.5, now, rampTime);
      }

      // HIGH pattern (hi-hats - constant with subtle pulse)
      const highLevel = 0.7 + Math.sin(patternStep * 0.5) * 0.15;
      highBus.gain.setTargetAtTime(highLevel, now, rampTime);

      patternStep++;
    };

    // Update pattern every beat
    this.rhythmicPatternInterval = window.setInterval(updatePattern, beatDuration * 1000);
    updatePattern(); // Initial update
  }

  /**
   * Stop rhythmic gating.
   */
  private stopRhythmicGating(): void {
    if (this.rhythmicPatternInterval !== null) {
      clearInterval(this.rhythmicPatternInterval);
      this.rhythmicPatternInterval = null;
    }

    // Reset gain nodes to default levels
    if (this.rhythmicGainNodes.length > 0 && this.audioContext) {
      const now = this.audioContext.currentTime;
      for (const node of this.rhythmicGainNodes) {
        if (node) {
          node.gain.setValueAtTime(1.0, now);
        }
      }
    }
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
      const relatedKey3 = await this.getMusicallyRelatedKey(pair.key);
      const relatedKey4 = await this.getMusicallyRelatedKey(pair.key);

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
    _pairEndTime: number,
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
        const relatedKey3 = await this.getMusicallyRelatedKey(pair.key);
        const relatedKey4 = await this.getMusicallyRelatedKey(pair.key);

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

      const track3 = pair.track3;
      const track4 = pair.track4;

      if (!track3 || !track4) {
        throw new Error('Failed to create hidden tracks');
      }

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
      // Create gain node for intro at 75% volume
      const intro3Gain = ctx.createGain();
      intro3Gain.gain.setValueAtTime(0.75, pairStartTime);
      intro3Source.connect(intro3Gain);
      intro3Gain.connect(this.track3Gain!);
      intro3Source.start(pairStartTime);
      intro3Source.onended = (): void => {
        intro3Source.disconnect();
        const idx = this.currentSources.indexOf(intro3Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro3Source);

      const main3Source = ctx.createBufferSource();
      main3Source.buffer = main3Buffer;
      main3Source.connect(this.track3Gain!);
      main3Source.start(mainStartTime);
      main3Source.onended = (): void => {
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
      intro4Source.onended = (): void => {
        intro4Source.disconnect();
        const idx = this.currentSources.indexOf(intro4Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro4Source);

      const main4Source = ctx.createBufferSource();
      main4Source.buffer = main4Buffer;
      main4Source.connect(this.track4Gain!);
      main4Source.start(mainStartTime);
      main4Source.onended = (): void => {
        main4Source.disconnect();
        const idx = this.currentSources.indexOf(main4Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(main4Source);

      // Only set up the switching interval for the current pair
      if (isCurrentPair) {
        this.setupMFSwitchesForCurrentPair(pair, mainStartTime);
      }

    } catch (err) {
      // Error scheduling hidden tracks
    }
  }

  private emit<K extends keyof PlayerEvents>(event: K, data: PlayerEvents[K]): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          (listener as EventListener<PlayerEvents[K]>)(data);
        } catch (err) {
          // Error in event listener
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

    // Clear Mannie Fresh mode switching timers
    if (this.hiddenTrackSwitchTimeout !== null) {
      clearTimeout(this.hiddenTrackSwitchTimeout);
      this.hiddenTrackSwitchTimeout = null;
    }
    if (this.hiddenTrackSwitchInterval !== null) {
      clearInterval(this.hiddenTrackSwitchInterval);
      this.hiddenTrackSwitchInterval = null;
    }
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

      // Resume recording if it was active
      if (this.isRecordingPaused && this.scriptProcessor && this.state.isRecordingArmed) {
        this.isRecordingPaused = false;
        this.updateState({ isPlaying: true, isPaused: false, isRecordingActive: true });
      } else {
        this.updateState({ isPlaying: true, isPaused: false });
      }
      return;
    }

    // Use pre-computed playlist if available
    if (this.precomputedPlaylist && this.precomputedPlaylist.length > 0) {
      const currentPair = this.precomputedPlaylist[this.precomputedIndex];
      const nextPair = this.precomputedPlaylist[this.precomputedIndex + 1];

      if (!currentPair) {
        throw new Error('Failed to get current pair from precomputed playlist');
      }

      // Preload both current and next pair
      await this.preloadNextPair(currentPair);
      if (nextPair) {
        await this.preloadNextPair(nextPair);
      }

      this.updateState({
        isPlaying: true,
        isPaused: false,
        currentPair,
        nextPair: nextPair || null,
        key: currentPair.key,
        tempo: currentPair.tempo,
        progressIndex: this.precomputedIndex,
      });

      // Start recording if armed (right before audio plays)
      if (this.state.isRecordingArmed && !this.state.isRecordingActive) {
        this.startRecordingNow();
      }

      await this.playPair(currentPair);
      return;
    }

    // Prepare first two pairs (each pair has 2 songs at same tempo)
    const entry1 = this.progression[this.progressIndex];
    const entry2 = this.progression[(this.progressIndex + 1) % this.progression.length];

    if (!entry1 || !entry2) {
      throw new Error('Failed to get progression entries');
    }

    // Pair 1: Use smart selection with key/tempo constraints
    const song1a = await this.getNextSongSmart(entry1.tempo, entry1.key, null, this.recentArtists.slice(0, 10));
    const song1b = await this.getNextSongSmart(entry1.tempo, entry1.key, song1a, [...this.recentArtists.slice(0, 10), song1a.artist]);

    // Mark pair as played and track songs
    this.markPairPlayed(song1a, song1b);
    this.playedSongIds.add(song1a.id);
    this.playedSongIds.add(song1b.id);
    this.recentSongs.unshift(song1a, song1b);
    if (this.recentSongs.length > 50) this.recentSongs = this.recentSongs.slice(0, 50);
    this.recentArtists.unshift(song1a.artist, song1b.artist);
    if (this.recentArtists.length > 30) this.recentArtists = this.recentArtists.slice(0, 30);

    // Pair 2: avoid same artist within pair and artists from pair 1
    const song2a = await this.getNextSongSmart(entry2.tempo, entry2.key, null, [...this.recentArtists.slice(0, 10), song1a.artist, song1b.artist]);
    const song2b = await this.getNextSongSmart(entry2.tempo, entry2.key, song2a, [...this.recentArtists.slice(0, 10), song2a.artist, song1a.artist, song1b.artist]);

    // Mark pair as played and track songs
    this.markPairPlayed(song2a, song2b);
    this.playedSongIds.add(song2a.id);
    this.playedSongIds.add(song2b.id);
    this.recentSongs.unshift(song2a, song2b);
    if (this.recentSongs.length > 50) this.recentSongs = this.recentSongs.slice(0, 50);
    this.recentArtists.unshift(song2a.artist, song2b.artist);
    if (this.recentArtists.length > 30) this.recentArtists = this.recentArtists.slice(0, 30);

    const currentPair = this.createTrackPair(song1a, song1b, entry1.key, entry1.tempo);
    const nextPair = this.createTrackPair(song2a, song2b, entry2.key, entry2.tempo);

    // Add hidden tracks to currentPair (first pair)
    const currentRelatedKey3 = await this.getMusicallyRelatedKey(entry1.key);
    const currentRelatedKey4 = await this.getMusicallyRelatedKey(entry1.key);
    const currentSong3 = await this.getNextSongSmart(entry1.tempo, currentRelatedKey3, null, [song1a.artist, song1b.artist], [song1a.id, song1b.id]);
    const currentSong4 = await this.getNextSongSmart(entry1.tempo, currentRelatedKey4, null, [song1a.artist, song1b.artist, currentSong3.artist], [song1a.id, song1b.id, currentSong3.id]);
    this.playedSongIds.add(currentSong3.id);
    this.playedSongIds.add(currentSong4.id);
    // Track MF tracks for recency too (they count as played!)
    this.recentSongs.unshift(currentSong3, currentSong4);
    if (this.recentSongs.length > 50) this.recentSongs = this.recentSongs.slice(0, 50);
    this.recentArtists.unshift(currentSong3.artist, currentSong4.artist);
    if (this.recentArtists.length > 30) this.recentArtists = this.recentArtists.slice(0, 30);
    currentPair.track3 = this.createTrack(currentSong3, currentRelatedKey3, entry1.tempo);
    currentPair.track4 = this.createTrack(currentSong4, currentRelatedKey4, entry1.tempo);

    // Add hidden tracks to nextPair
    const relatedKey3 = await this.getMusicallyRelatedKey(entry2.key);
    const relatedKey4 = await this.getMusicallyRelatedKey(entry2.key);
    const song3 = await this.getNextSongSmart(entry2.tempo, relatedKey3, null, [song2a.artist, song2b.artist], [song2a.id, song2b.id]);
    const song4 = await this.getNextSongSmart(entry2.tempo, relatedKey4, null, [song2a.artist, song2b.artist, song3.artist], [song2a.id, song2b.id, song3.id]);
    this.playedSongIds.add(song3.id);
    this.playedSongIds.add(song4.id);
    // Track MF tracks for recency too
    this.recentSongs.unshift(song3, song4);
    if (this.recentSongs.length > 50) this.recentSongs = this.recentSongs.slice(0, 50);
    this.recentArtists.unshift(song3.artist, song4.artist);
    if (this.recentArtists.length > 30) this.recentArtists = this.recentArtists.slice(0, 30);
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

    // Start recording if armed (right before audio plays)
    if (this.state.isRecordingArmed && !this.state.isRecordingActive) {
      this.startRecordingNow();
    }

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
      // Create gain node for intro at 75% volume
      const intro1Gain = ctx.createGain();
      intro1Gain.gain.setValueAtTime(0.75, this.pairStartTime);
      intro1Source.connect(intro1Gain);
      intro1Gain.connect(this.track1Gain!);
      intro1Source.start(this.pairStartTime);
      intro1Source.onended = (): void => {
        intro1Source.disconnect();
        const idx = this.currentSources.indexOf(intro1Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro1Source);

      const main1Source = ctx.createBufferSource();
      main1Source.buffer = main1Buffer;
      main1Source.connect(this.track1Gain!);
      main1Source.start(mainStartTime);
      main1Source.onended = (): void => {
        main1Source.disconnect();
        const idx = this.currentSources.indexOf(main1Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(main1Source);

      // Schedule Track 2 intro + main with Web Audio API (sample-accurate)
      const intro2Source = ctx.createBufferSource();
      intro2Source.buffer = intro2Buffer;
      // Create gain node for intro at 75% volume
      const intro2Gain = ctx.createGain();
      intro2Gain.gain.setValueAtTime(0.75, this.pairStartTime);
      intro2Source.connect(intro2Gain);
      intro2Gain.connect(this.track2Gain!);
      intro2Source.start(this.pairStartTime);
      intro2Source.onended = (): void => {
        intro2Source.disconnect();
        const idx = this.currentSources.indexOf(intro2Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro2Source);

      const main2Source = ctx.createBufferSource();
      main2Source.buffer = main2Buffer;
      main2Source.connect(this.track2Gain!);
      main2Source.start(mainStartTime);
      main2Source.onended = (): void => {
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
      await this.preloadNextPair(this.state.nextPair);

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
      const intro1Source = ctx.createBufferSource();
      intro1Source.buffer = intro1Buffer;
      // Create gain node for intro at 75% volume
      const intro1Gain = ctx.createGain();
      intro1Gain.gain.setValueAtTime(0.75, startTime);
      intro1Source.connect(intro1Gain);
      intro1Gain.connect(this.track1Gain!);
      intro1Source.start(startTime);

      // Clean up source after it finishes to prevent memory leaks
      intro1Source.onended = (): void => {
        intro1Source.disconnect();
        const idx = this.currentSources.indexOf(intro1Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro1Source);

      const main1Source = ctx.createBufferSource();
      main1Source.buffer = main1Buffer;
      main1Source.connect(this.track1Gain!);
      main1Source.start(mainStartTime);

      main1Source.onended = (): void => {
        main1Source.disconnect();
        const idx = this.currentSources.indexOf(main1Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(main1Source);

      const intro2Source = ctx.createBufferSource();
      intro2Source.buffer = intro2Buffer;
      // Create gain node for intro at 75% volume
      const intro2Gain = ctx.createGain();
      intro2Gain.gain.setValueAtTime(0.75, startTime);
      intro2Source.connect(intro2Gain);
      intro2Gain.connect(this.track2Gain!);
      intro2Source.start(startTime);

      intro2Source.onended = (): void => {
        intro2Source.disconnect();
        const idx = this.currentSources.indexOf(intro2Source);
        if (idx > -1) this.currentSources.splice(idx, 1);
      };
      this.currentSources.push(intro2Source);

      const main2Source = ctx.createBufferSource();
      main2Source.buffer = main2Buffer;
      main2Source.connect(this.track2Gain!);
      main2Source.start(mainStartTime);

      main2Source.onended = (): void => {
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

      // Use pre-computed playlist if available
      let newNextPair: TrackPair;
      if (this.precomputedPlaylist && this.precomputedPlaylist.length > 0) {
        // Check if we've reached the end of the playlist
        const isLastPair = this.precomputedIndex >= this.precomputedPlaylist.length - 2;

        if (isLastPair) {
          // Generate new playlist and emit event for URL update
          const newMix = await this.generateCompleteMix();
          this.precomputedPlaylist = newMix;
          this.precomputedIndex = 0;

          // Emit custom event for playlist regeneration (App.tsx will handle URL update)
          if (typeof window !== 'undefined') {
            const event = new CustomEvent('playlist-regenerated', {
              detail: {
                playlist: newMix,
                encodedPlaylist: this.encodePlaylistToURL(newMix)
              }
            });
            window.dispatchEvent(event);
          }
        } else {
          // Advance to next pair in precomputed playlist
          this.precomputedIndex = this.precomputedIndex + 1;
        }

        const nextPrecomputedPair = this.precomputedPlaylist[(this.precomputedIndex + 1) % this.precomputedPlaylist.length];
        if (!nextPrecomputedPair) {
          throw new Error('Failed to get next pair from precomputed playlist');
        }
        newNextPair = nextPrecomputedPair;
        this.progressIndex = this.precomputedIndex;
      } else {
        // Update progression index (move to the pair we just scheduled)
        this.progressIndex = (this.progressIndex + 1) % this.progression.length;

        // Prepare the NEW next pair using smart selection
        const nextEntry = this.progression[(this.progressIndex + 1) % this.progression.length];
        if (!nextEntry) {
          throw new Error('Failed to get next progression entry');
        }

        const avoidArtists = [
          ...this.recentArtists.slice(0, 10),
          pairToSchedule.track1.song.artist,
          pairToSchedule.track2.song.artist
        ];
        const song1 = await this.getNextSongSmart(nextEntry.tempo, nextEntry.key, null, avoidArtists);
        const song2 = await this.getNextSongSmart(nextEntry.tempo, nextEntry.key, song1, [...avoidArtists, song1.artist]);

        // Mark pair as played and track songs
        this.markPairPlayed(song1, song2);
        this.playedSongIds.add(song1.id);
        this.playedSongIds.add(song2.id);
        this.recentSongs.unshift(song1, song2);
        if (this.recentSongs.length > 50) this.recentSongs = this.recentSongs.slice(0, 50);
        this.recentArtists.unshift(song1.artist, song2.artist);
        if (this.recentArtists.length > 30) this.recentArtists = this.recentArtists.slice(0, 30);

        newNextPair = this.createTrackPair(song1, song2, nextEntry.key, nextEntry.tempo);

        // Add hidden tracks to the new next pair
        const relatedKey3 = await this.getMusicallyRelatedKey(nextEntry.key);
        const relatedKey4 = await this.getMusicallyRelatedKey(nextEntry.key);
        const song3 = await this.getNextSongSmart(nextEntry.tempo, relatedKey3, null, [song1.artist, song2.artist], [song1.id, song2.id]);
        const song4 = await this.getNextSongSmart(nextEntry.tempo, relatedKey4, null, [song1.artist, song2.artist, song3.artist], [song1.id, song2.id, song3.id]);
        this.playedSongIds.add(song3.id);
        this.playedSongIds.add(song4.id);
        // Track MF tracks for recency
        this.recentSongs.unshift(song3, song4);
        if (this.recentSongs.length > 50) this.recentSongs = this.recentSongs.slice(0, 50);
        this.recentArtists.unshift(song3.artist, song4.artist);
        if (this.recentArtists.length > 30) this.recentArtists = this.recentArtists.slice(0, 30);
        newNextPair.track3 = this.createTrack(song3, relatedKey3, nextEntry.tempo);
        newNextPair.track4 = this.createTrack(song4, relatedKey4, nextEntry.tempo);
      }

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

        const currentEntry = this.progression[this.progressIndex]!;
        this.updateState({
          currentPair: pairToSchedule,
          nextPair: newNextPair,
          key: currentEntry.key,
          tempo: currentEntry.tempo,
          progressIndex: this.progressIndex,
        });
        this.emit('pairStart', pairToSchedule);
        this.emit('introStart', pairToSchedule);

        // Set up MF mode switches for this pair NOW (when it becomes current)
        // Always set up switches - they'll check MF mode state when they fire
        if (pairToSchedule.track3 && pairToSchedule.track4) {
          this.setupMFSwitchesForCurrentPair(pairToSchedule, mainStartTime);
        }
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
   * Load audio buffer with retry logic.
   */
  private async loadAudioBuffer(url: string, retryCount = 0): Promise<AudioBuffer> {

    // Check if already cached
    if (this.preloadedBuffers.has(url)) {
      return this.preloadedBuffers.get(url)!;
    }

    // Check if already loading - return the existing promise to prevent duplicates
    if (this.pendingLoads.has(url)) {
      return await this.pendingLoads.get(url)!;
    }

    // Create a promise for this load and store it
    const loadPromise = this.performLoad(url, retryCount);
    this.pendingLoads.set(url, loadPromise);

    try {
      const buffer = await loadPromise;
      this.pendingLoads.delete(url);
      return buffer;
    } catch (err) {
      this.pendingLoads.delete(url);
      throw err;
    }
  }

  /**
   * Perform the actual load operation.
   */
  private async performLoad(url: string, retryCount: number): Promise<AudioBuffer> {
    const MAX_RETRIES = 3;
    const fileName = url.split('/').pop() || url;
    const ctx = this.ensureAudioContext();

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();

      // Validate the download
      if (arrayBuffer.byteLength === 0) {
        throw new Error('Empty file received');
      }


      // Check AudioContext state
      if (ctx.state !== 'running' && ctx.state !== 'suspended') {
        throw new Error(`AudioContext in unexpected state: ${ctx.state}`);
      }

      // Validate audio file header
      // Support: WAV (RIFF), AIFF (FORM), MP3 (ID3 or 0xFF sync), and others
      const header = new Uint8Array(arrayBuffer.slice(0, 4));
      const headerStr = String.fromCharCode(...header);
      const firstByte = header[0];

      // Check for valid audio headers
      const isWAV = headerStr === 'RIFF';
      const isAIFF = headerStr === 'FORM';
      const isMP3 = headerStr.startsWith('ID3') || firstByte === 0xFF; // ID3 tag or MP3 frame sync
      const isValid = isWAV || isAIFF || isMP3;

      if (!isValid) {
        throw new Error(`Invalid audio file header for ${fileName}: "${headerStr}"`);
      }


      // Clone the arrayBuffer for decoding (prevents issues if buffer is modified)
      const bufferCopy = arrayBuffer.slice(0);

      // Decode audio data
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(bufferCopy);
      } catch (decodeErr) {
        // If promise-based fails, try callback-based (some browsers prefer this)
        const bufferCopy2 = arrayBuffer.slice(0);
        buffer = await new Promise<AudioBuffer>((resolve, reject) => {
          ctx.decodeAudioData(
            bufferCopy2,
            (decodedBuffer) => resolve(decodedBuffer),
            (err) => reject(new Error(`Decode failed: ${err?.message || 'Unknown error'}`))
          );
        });
      }

      // Cache for future use
      this.preloadedBuffers.set(url, buffer);

      // Limit cache size to prevent memory issues on iOS
      // Keep only the most recent 12 buffers (3 pairs × 4 files)
      if (this.preloadedBuffers.size > 12) {
        const firstKey = this.preloadedBuffers.keys().next().value as string;
        if (firstKey) {
          this.preloadedBuffers.delete(firstKey);
        }
      }

      return buffer;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Retry logic for intermittent failures
      if (retryCount < MAX_RETRIES) {
        const delay = Math.pow(2, retryCount) * 500; // Exponential backoff: 500ms, 1s, 2s
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.loadAudioBuffer(url, retryCount + 1);
      }

      // After all retries failed, throw detailed error
      throw new Error(`Failed to load ${fileName} after ${MAX_RETRIES} retries: ${errorMsg}`);
    }
  }

  /**
   * Preload the next pair's audio for seamless cueing (Kwyjibo style).
   */
  private async preloadNextPair(pair: TrackPair): Promise<void> {
    try {
      const urls = [
        pair.track1.introUrl,
        pair.track1.mainUrl,
        pair.track2.introUrl,
        pair.track2.mainUrl,
      ];

      // Load all files in parallel
      await Promise.allSettled(
        urls.map(url =>
          this.preloadedBuffers.has(url) ? Promise.resolve() : this.loadAudioBuffer(url)
        )
      );
    } catch (err) {
      // Preload failures are non-critical
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
    if (!nextEntry) {
      throw new Error('Failed to get next progression entry');
    }

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
      key: this.progression[this.progressIndex]!.key,
      tempo: this.progression[this.progressIndex]!.tempo,
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

    // Pause recording if active (just set flag, ScriptProcessor keeps running)
    if (this.state.isRecordingActive) {
      this.isRecordingPaused = true;
    }

    this.clearScheduled();
    this.updateState({ isPaused: true, isPlaying: false, isRecordingActive: false });
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

    // Always stop and save recording
    this.stopRecording();

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
      } catch {
        // Ignore errors (source may already be stopped)
      }
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
      } catch {
        // Ignore errors (source may already be stopped)
      }
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
      this.playedSongIds.clear();
      this.hamiltonianPath = [...this.songs]; // Use unshuffled songs - main randomness comes from init()
    } else {
      this.hamiltonianPath = unplayedSongs; // Use unshuffled unplayed songs
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
   * Uses WEIGHTED pair counts per tempo for equal song distribution.
   * More songs at a tempo = more pairs played at that tempo.
   * Key order: startKey → startKey+1 → ... → 10 → 1 → ... (cycles through)
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
        const tempo = ALL_TEMPOS[(startTempoIndex + tempoOffset) % ALL_TEMPOS.length]!;

        // Get WEIGHTED pair count for this tempo (based on song availability)
        const pairCount = this.tempoPairCounts.get(tempo) || 10;

        // Generate the weighted number of pairs for this tempo
        // Cycles through all 10 keys as many times as needed
        for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
          const key = KEYS_TO_USE[(startKeyIndex + pairIndex) % KEYS_TO_USE.length]!;
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
      // Regenerate progression from this key
      this.progression = this.generateProgressionFromPoint(key, this.state.tempo);
      this.progressIndex = 0;
      this.updateState({ key });
      return;
    }

    // Recalculate Hamiltonian path starting from this key
    const currentTempo = this.state.tempo;
    this.recalculateHamiltonianPath(key, currentTempo);

    // Prepare new next pair - avoid artists from current pair
    const nextEntry = this.progression[(this.progressIndex + 1) % this.progression.length];
    if (!nextEntry) {
      throw new Error('Failed to get next progression entry');
    }
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
      // Regenerate progression from this tempo
      this.progression = this.generateProgressionFromPoint(this.state.key, tempo);
      this.progressIndex = 0;
      this.updateState({ tempo });
      return;
    }

    // Don't touch MF switches when tempo changes - let current pair finish with
    // its original tempo timing. Next pair will start with correct new tempo.

    // Recalculate Hamiltonian path starting from this tempo
    const currentKey = this.state.key;
    this.recalculateHamiltonianPath(currentKey, tempo);

    // Prepare new next pair - avoid artists from current pair
    const nextEntry = this.progression[(this.progressIndex + 1) % this.progression.length];
    if (!nextEntry) {
      throw new Error('Failed to get next progression entry');
    }
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

      // eslint-disable-next-line no-constant-condition
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
        if (song && song.bpm === tempo) {
          tempPathIndexes.set(tempo, searchIndex + 1);
          return song;
        }

        searchIndex++;
      }
    };

    for (let i = 0; i < Math.min(count, this.progression.length); i++) {
      const entry = this.progression[i];
      if (!entry) continue;

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

  /**
   * Arm recording (ready to record, but wait for playback to start).
   */
  armRecording(): void {
    // Ensure audio context exists (creates it if needed)
    this.ensureAudioContext();

    if (!this.mediaStreamDestination) {
      return;
    }

    this.updateState({
      isRecordingArmed: true,
    });
  }

  /**
   * Disarm recording without starting it.
   */
  disarmRecording(): void {
    this.updateState({
      isRecordingArmed: false,
    });
  }

  /**
   * Actually start the recording (called internally when playback starts).
   * Uses ScriptProcessorNode to capture raw PCM audio for lossless WAV export.
   */
  private startRecordingNow(): void {
    if (!this.audioContext || this.scriptProcessor) {
      return;
    }

    try {
      const ctx = this.audioContext;
      const bufferSize = 4096;
      const numChannels = 2;

      // Create ScriptProcessorNode to capture raw audio
      this.scriptProcessor = ctx.createScriptProcessor(bufferSize, numChannels, numChannels);

      this.recordedBuffers = [];
      this.isRecordingPaused = false;
      this.recordingStartTime = Date.now();

      // Capture audio buffers
      this.scriptProcessor.onaudioprocess = (event: AudioProcessingEvent): void => {
        if (this.isRecordingPaused) return;

        // Copy left and right channels
        const leftChannel = new Float32Array(event.inputBuffer.getChannelData(0));
        const rightChannel = new Float32Array(event.inputBuffer.getChannelData(1));

        this.recordedBuffers.push(leftChannel, rightChannel);
      };

      // Connect to master compressor to capture final output
      if (this.masterCompressor) {
        this.masterCompressor.connect(this.scriptProcessor);
        this.scriptProcessor.connect(ctx.destination);
      }

      // Update duration every second
      this.recordingTimer = window.setInterval(() => {
        const duration = Math.floor((Date.now() - this.recordingStartTime) / 1000);
        this.updateState({
          recordingDuration: duration,
        });
      }, 1000);

      this.updateState({
        isRecordingActive: true,
        recordingDuration: 0,
      });
    } catch (err) {
      // Recording failed
      this.updateState({
        isRecordingArmed: false,
        isRecordingActive: false,
      });
    }
  }

  /**
   * Stop recording and download the file.
   */
  stopRecording(): void {
    if (this.scriptProcessor && this.state.isRecordingActive) {
      // Stop capturing audio
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;

      if (this.recordingTimer) {
        clearInterval(this.recordingTimer);
        this.recordingTimer = null;
      }

      // Encode to WAV and download
      if (this.recordedBuffers.length > 0 && this.audioContext) {
        const sampleRate = this.audioContext.sampleRate;
        const numChannels = 2;

        // Separate left and right channels
        const leftBuffers: Float32Array[] = [];
        const rightBuffers: Float32Array[] = [];
        for (let i = 0; i < this.recordedBuffers.length; i += 2) {
          leftBuffers.push(this.recordedBuffers[i]);
          rightBuffers.push(this.recordedBuffers[i + 1]);
        }

        // Encode to WAV
        const wavBlob = encodeWAV([
          this.concatenateBuffers(leftBuffers),
          this.concatenateBuffers(rightBuffers)
        ], sampleRate, numChannels);

        // Create filename with date and time
        const date = new Date();
        const dateTimeStr = date.toISOString().replace(/:/g, '-').replace(/\..+/, '').replace('T', '_') || 'recording';
        const baseFilename = `${dateTimeStr}`;

        // Auto-download the recording
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `${baseFilename}.wav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Download playlist file
        this.downloadPlaylist(baseFilename);
      }

      // Clear recording state
      this.recordedBuffers = [];
      this.recordingStartTime = 0;
      this.updateState({
        isRecordingArmed: false,
        isRecordingActive: false,
        recordingDuration: 0,
      });
    } else if (this.state.isRecordingArmed) {
      // Not actively recording, just disarm
      this.disarmRecording();
    }
  }

  /**
   * Helper to concatenate audio buffers.
   */
  private concatenateBuffers(buffers: Float32Array[]): Float32Array {
    const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (const buffer of buffers) {
      result.set(buffer, offset);
      offset += buffer.length;
    }
    return result;
  }

  /**
   * Generate the complete planned mix (all pairs with all 4 tracks).
   */
  async generateCompleteMix(): Promise<TrackPair[]> {
    const completeMix: TrackPair[] = [];
    const tempPlayedSongIds = new Set<number>();
    const tempRecentArtists: string[] = [];
    const tempRecentSongs: Song[] = [];

    // Continue generating pairs until we've used all (or most) songs
    // Each pair uses 4 songs, so we need roughly songs.length / 4 pairs
    const targetPairs = Math.ceil(this.songs.length / 4);
    let progressionIndex = 0;

    for (let i = 0; i < targetPairs; i++) {
      // Cycle through progression for key/tempo guidance
      const entry = this.progression[progressionIndex % this.progression.length];
      if (!entry) continue;
      progressionIndex++;

      try {
        // Generate pair with same logic as real playback
        const song1 = await this.getNextSongSmart(entry.tempo, entry.key, null, tempRecentArtists.slice(0, 10), Array.from(tempPlayedSongIds));
        const song2 = await this.getNextSongSmart(entry.tempo, entry.key, song1, [...tempRecentArtists.slice(0, 10), song1.artist], Array.from(tempPlayedSongIds));

        // Track songs
        tempPlayedSongIds.add(song1.id);
        tempPlayedSongIds.add(song2.id);
        tempRecentSongs.unshift(song1, song2);
        if (tempRecentSongs.length > 50) tempRecentSongs.splice(50);
        tempRecentArtists.unshift(song1.artist, song2.artist);
        if (tempRecentArtists.length > 30) tempRecentArtists.splice(30);

        // Generate hidden tracks (tracks 3 and 4)
        const relatedKey3 = ((entry.key + 4) % 10) + 1 as Key;
        const relatedKey4 = ((entry.key + 7) % 10) + 1 as Key;

        const song3 = await this.getNextSongSmart(entry.tempo, relatedKey3, null, [...tempRecentArtists.slice(0, 10), song1.artist, song2.artist], Array.from(tempPlayedSongIds));
        const song4 = await this.getNextSongSmart(entry.tempo, relatedKey4, song3, [...tempRecentArtists.slice(0, 10), song3.artist, song1.artist, song2.artist], Array.from(tempPlayedSongIds));

        tempPlayedSongIds.add(song3.id);
        tempPlayedSongIds.add(song4.id);
        tempRecentSongs.unshift(song3, song4);
        if (tempRecentSongs.length > 50) tempRecentSongs.splice(50);
        tempRecentArtists.unshift(song3.artist, song4.artist);
        if (tempRecentArtists.length > 30) tempRecentArtists.splice(30);

        // Create the complete pair
        const pair: TrackPair = {
          track1: this.createTrack(song1, entry.key, entry.tempo),
          track2: this.createTrack(song2, entry.key, entry.tempo),
          track3: this.createTrack(song3, relatedKey3, entry.tempo),
          track4: this.createTrack(song4, relatedKey4, entry.tempo),
          key: entry.key,
          tempo: entry.tempo,
        };

        completeMix.push(pair);
      } catch (err) {
        // Skip this pair if generation fails
      }
    }

    return completeMix;
  }

  /**
   * Export the complete planned mix as a text file.
   */
  async exportCompleteMix(): Promise<void> {
    const completeMix = await this.generateCompleteMix();
    const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    let playlistText = `KWYJIBO COMPLETE MIX - ${new Date().toLocaleString()}\n`;
    playlistText += `${'='.repeat(60)}\n\n`;
    playlistText += `Total Sets: ${completeMix.length}\n`;

    // Calculate statistics
    const allSongIds = new Set<number>();
    completeMix.forEach(pair => {
      allSongIds.add(pair.track1.song.id);
      allSongIds.add(pair.track2.song.id);
      if (pair.track3) allSongIds.add(pair.track3.song.id);
      if (pair.track4) allSongIds.add(pair.track4.song.id);
    });

    const totalDurationSeconds = completeMix.reduce((sum, pair) => {
      return sum + pair.track1.introDuration + pair.track1.mainDuration;
    }, 0);
    const durationMinutes = Math.floor(totalDurationSeconds / 60);

    playlistText += `Unique Songs: ${allSongIds.size} / ${this.songs.length}\n`;
    playlistText += `Total Duration: ~${durationMinutes} minutes\n\n`;

    completeMix.forEach((pair, idx) => {
      playlistText += `SET ${idx + 1}\n`;
      playlistText += `${'-'.repeat(40)}\n`;
      playlistText += `Key: ${KEY_NAMES[pair.key - 1]}  |  Tempo: ${pair.tempo} BPM\n\n`;

      playlistText += `  1. ${pair.track1.song.artist} - ${pair.track1.song.title}\n`;
      playlistText += `     Key: ${KEY_NAMES[pair.track1.song.key - 1]}\n\n`;

      playlistText += `  2. ${pair.track2.song.artist} - ${pair.track2.song.title}\n`;
      playlistText += `     Key: ${KEY_NAMES[pair.track2.song.key - 1]}\n\n`;

      if (pair.track3) {
        playlistText += `  3. ${pair.track3.song.artist} - ${pair.track3.song.title}\n`;
        playlistText += `     Key: ${KEY_NAMES[pair.track3.song.key - 1]}\n\n`;
      }

      if (pair.track4) {
        playlistText += `  4. ${pair.track4.song.artist} - ${pair.track4.song.title}\n`;
        playlistText += `     Key: ${KEY_NAMES[pair.track4.song.key - 1]}\n\n`;
      }

      playlistText += '\n';
    });

    playlistText += `\n${'='.repeat(60)}\n`;
    playlistText += `Mixed with KWYJIBO\n`;
    playlistText += `Quantum-powered Hamiltonian DJ technology\n`;

    // Download the file
    const blob = new Blob([playlistText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    const dateStr = new Date().toISOString().split('T')[0];
    a.download = `${dateStr}-complete-mix.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Download playlist as a text file.
   */
  private downloadPlaylist(baseFilename: string): void {
    const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    let playlistText = `KWYJIBO DJ SET - ${new Date().toLocaleString()}\n`;
    playlistText += `${'='.repeat(60)}\n\n`;

    if (this.playHistory.length === 0) {
      playlistText += 'No tracks played during this recording.\n';
    } else {
      playlistText += `Total Sets: ${this.playHistory.length}\n\n`;

      this.playHistory.forEach((pair, idx) => {
        playlistText += `SET ${idx + 1}\n`;
        playlistText += `${'-'.repeat(40)}\n`;
        playlistText += `Key: ${KEY_NAMES[pair.key - 1]}  |  Tempo: ${pair.tempo} BPM\n\n`;

        playlistText += `  1. ${pair.track1.song.artist} - ${pair.track1.song.title}\n`;
        playlistText += `     Key: ${KEY_NAMES[pair.track1.song.key - 1]}\n\n`;

        playlistText += `  2. ${pair.track2.song.artist} - ${pair.track2.song.title}\n`;
        playlistText += `     Key: ${KEY_NAMES[pair.track2.song.key - 1]}\n\n`;

        if (pair.track3) {
          playlistText += `  3. ${pair.track3.song.artist} - ${pair.track3.song.title}\n`;
          playlistText += `     Key: ${KEY_NAMES[pair.track3.song.key - 1]}\n\n`;
        }

        if (pair.track4) {
          playlistText += `  4. ${pair.track4.song.artist} - ${pair.track4.song.title}\n`;
          playlistText += `     Key: ${KEY_NAMES[pair.track4.song.key - 1]}\n\n`;
        }

        playlistText += '\n';
      });
    }

    playlistText += `\n${'='.repeat(60)}\n`;
    playlistText += `Mixed with KWYJIBO\n`;
    playlistText += `Quantum-powered Hamiltonian DJ technology\n`;

    // Create and download the text file
    const blob = new Blob([playlistText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `${baseFilename}-playlist.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Set a pre-computed playlist for URL-based playback.
   */
  setPrecomputedPlaylist(playlist: TrackPair[]): void {
    this.precomputedPlaylist = playlist;
    this.precomputedIndex = 0;

    // Update state with first pair
    if (playlist.length > 0 && playlist[0]) {
      this.updateState({
        key: playlist[0].key,
        tempo: playlist[0].tempo,
        currentPair: null,
        nextPair: playlist[0],
      });
    }
  }

  /**
   * Get the pre-computed playlist.
   */
  getPrecomputedPlaylist(): TrackPair[] | null {
    return this.precomputedPlaylist;
  }

  /**
   * Encode a playlist to URL parameter format.
   * Format: k1,t1,id1a,id1b,id1c,id1d|k2,t2,id2a,id2b,id2c,id2d|...
   */
  encodePlaylistToURL(playlist: TrackPair[]): string {
    const encoded = playlist.map(pair => {
      const parts = [
        pair.key.toString(),
        pair.tempo.toString(),
        pair.track1.song.id.toString(),
        pair.track2.song.id.toString(),
        pair.track3?.song.id.toString() || '0',
        pair.track4?.song.id.toString() || '0',
      ];
      return parts.join(',');
    });
    return encoded.join('|');
  }

  /**
   * Decode a playlist from URL parameter format.
   */
  async decodePlaylistFromURL(urlParams: string): Promise<TrackPair[]> {
    const playlist: TrackPair[] = [];
    const pairs = urlParams.split('|');

    for (const pairStr of pairs) {
      const parts = pairStr.split(',').map(p => parseInt(p, 10));
      if (parts.length !== 6) continue;

      const [key, tempo, id1, id2, id3, id4] = parts;
      if (!key || !tempo || !id1 || !id2) continue;

      // Find songs by ID
      const song1 = this.songs.find(s => s.id === id1);
      const song2 = this.songs.find(s => s.id === id2);
      if (!song1 || !song2) continue;

      const song3 = id3 && id3 !== 0 ? this.songs.find(s => s.id === id3) : undefined;
      const song4 = id4 && id4 !== 0 ? this.songs.find(s => s.id === id4) : undefined;

      // Calculate related keys for tracks 3 and 4
      const relatedKey3 = ((key + 4) % 10) + 1 as Key;
      const relatedKey4 = ((key + 7) % 10) + 1 as Key;

      // Create the pair
      const pair: TrackPair = {
        track1: this.createTrack(song1, key as Key, tempo as Tempo),
        track2: this.createTrack(song2, key as Key, tempo as Tempo),
        track3: song3 ? this.createTrack(song3, relatedKey3, tempo as Tempo) : undefined,
        track4: song4 ? this.createTrack(song4, relatedKey4, tempo as Tempo) : undefined,
        key: key as Key,
        tempo: tempo as Tempo,
      };

      playlist.push(pair);
    }

    return playlist;
  }
}
