import React, { useEffect, useState, useRef, useMemo } from 'react';
import { HamiltonianPlayer, TrackPair } from './player/HamiltonianPlayer';
import type { PlayerState } from './player/HamiltonianPlayer';
import { songs } from '../src';
import type { Key, Tempo } from '../src';
import { ALL_TEMPOS } from '../src';
import { SettingsModal } from './components/SettingsModal';

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Wake Lock API types
interface WakeLockSentinel {
  release(): Promise<void>;
}

function App(): React.ReactElement {
  const [disabledSongs, setDisabledSongs] = useState<Set<number>>(new Set());
  const [showSettings, setShowSettings] = useState(false);

  // Load disabled songs from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('disabled-songs');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as number[];
        setDisabledSongs(new Set(parsed));
      } catch (err) {
        // Failed to load disabled songs
      }
    }
  }, []);

  // Filter songs based on disabled list
  const enabledSongs = useMemo(() => {
    return songs.filter(song => !disabledSongs.has(song.id));
  }, [disabledSongs]);

  const [player] = useState(() => new HamiltonianPlayer(enabledSongs));
  const [playerState, setPlayerState] = useState<PlayerState>(player.getState());
  const [currentTrack, setCurrentTrack] = useState<'intro' | 'main'>('intro');
  const [playHistory, setPlayHistory] = useState<TrackPair[]>([]);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const [hasStartedPlaying, setHasStartedPlaying] = useState(false);
  const [completeMix, setCompleteMix] = useState<TrackPair[]>([]);

  // Update player when enabled songs change
  useEffect(() => {
    if (enabledSongs.length > 0) {
      player.updateSongs(enabledSongs);
    }
  }, [enabledSongs, player]);

  // Initialize player and generate playlist
  useEffect(() => {
    const initializePlayerAndPlaylist = async (): Promise<void> => {
      // First, initialize player with quantum randomness (randomizes starting key/tempo)
      await player.init();

      // Then handle URL-based playlist
      const urlParams = new URLSearchParams(window.location.search);
      const playlistParam = urlParams.get('playlist');

      if (playlistParam) {
        // Decode and load playlist from URL
        try {
          const decodedPlaylist = await player.decodePlaylistFromURL(playlistParam);
          player.setPrecomputedPlaylist(decodedPlaylist);
          setCompleteMix(decodedPlaylist);
        } catch (err) {
          // Failed to decode, generate new one
          const newMix = await player.generateCompleteMix();
          player.setPrecomputedPlaylist(newMix);
          setCompleteMix(newMix);

          // Update URL with new playlist
          const encoded = player.encodePlaylistToURL(newMix);
          const newUrl = `${window.location.pathname}?playlist=${encoded}`;
          window.history.replaceState({}, '', newUrl);
        }
      } else {
        // No playlist in URL, generate and encode one
        const newMix = await player.generateCompleteMix();
        player.setPrecomputedPlaylist(newMix);
        setCompleteMix(newMix);

        // Update URL with playlist
        const encoded = player.encodePlaylistToURL(newMix);
        const newUrl = `${window.location.pathname}?playlist=${encoded}`;
        window.history.replaceState({}, '', newUrl);
      }
    };

    void initializePlayerAndPlaylist();
  }, [player]);

  // Listen for playlist regeneration events
  useEffect(() => {
    const handlePlaylistRegenerated = (event: Event): void => {
      const customEvent = event as CustomEvent<{
        playlist: TrackPair[];
        encodedPlaylist: string;
      }>;

      // Update state with new playlist
      setCompleteMix(customEvent.detail.playlist);

      // Update URL with new playlist
      const newUrl = `${window.location.pathname}?playlist=${customEvent.detail.encodedPlaylist}`;
      window.history.replaceState({}, '', newUrl);
    };

    window.addEventListener('playlist-regenerated', handlePlaylistRegenerated);

    return (): void => {
      window.removeEventListener('playlist-regenerated', handlePlaylistRegenerated);
    };
  }, []);

  // Wake Lock functionality
  useEffect(() => {
    const requestWakeLock = async (): Promise<void> => {
      try {
        if ('wakeLock' in navigator) {
          const nav = navigator as Navigator & { wakeLock: { request: (type: string) => Promise<WakeLockSentinel> } };
          wakeLockRef.current = await nav.wakeLock.request('screen');
        }
      } catch (err) {
        // Wake Lock not supported or denied
      }
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void requestWakeLock();
      } else {
        // Pause playback when page becomes hidden (phone locks, tab switched, etc.)
        if (playerState.isPlaying) {
          void player.pause();
        }
      }
    };

    void requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return (): void => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockRef.current) {
        void wakeLockRef.current.release();
      }
    };
  }, [player, playerState.isPlaying]);

  useEffect(() => {
    // Subscribe to player events
    const unsubscribeState = player.on('stateChange', (state): void => {
      setPlayerState(state);
    });

    const unsubscribeIntro = player.on('introStart', (): void => {
      setCurrentTrack('intro');
    });

    const unsubscribeMain = player.on('mainStart', (): void => {
      setCurrentTrack('main');
    });

    const unsubscribePairStart = player.on('pairStart', (pair): void => {
      // Add the starting pair to history
      setPlayHistory(prev => [...prev, pair]);
    });

    const unsubscribeError = player.on('error', (): void => {
      // Player error logged by player
    });

    return (): void => {
      unsubscribeState();
      unsubscribeIntro();
      unsubscribeMain();
      unsubscribePairStart();
      unsubscribeError();
    };
  }, [player]);

  const handlePlay = (): void => {
    setHasStartedPlaying(true);
    void player.play();
  };

  const handlePause = (): void => {
    void player.pause();
  };

  const handleStop = (): void => {
    player.stop();
  };

  const handleKeyChange = async (key: Key): Promise<void> => {
    if (!hasStartedPlaying) {
      // Before playback starts, regenerate playlist from this key
      player.setKey(key);
      const newMix = await player.generateCompleteMix();
      player.setPrecomputedPlaylist(newMix);
      setCompleteMix(newMix);

      // Update URL with new playlist
      const encoded = player.encodePlaylistToURL(newMix);
      const newUrl = `${window.location.pathname}?playlist=${encoded}`;
      window.history.replaceState({}, '', newUrl);
    } else {
      // During playback, just change the key
      player.setKey(key);
    }
  };

  const handleTempoChange = async (tempo: Tempo): Promise<void> => {
    if (!hasStartedPlaying) {
      // Before playback starts, regenerate playlist from this tempo
      player.setTempo(tempo);
      const newMix = await player.generateCompleteMix();
      player.setPrecomputedPlaylist(newMix);
      setCompleteMix(newMix);

      // Update URL with new playlist
      const encoded = player.encodePlaylistToURL(newMix);
      const newUrl = `${window.location.pathname}?playlist=${encoded}`;
      window.history.replaceState({}, '', newUrl);
    } else {
      // During playback, just change the tempo
      player.setTempo(tempo);
    }
  };

  const handleMannieFreshToggle = (): void => {
    player.toggleMannieFreshMode();
  };

  const handle808Toggle = (): void => {
    player.toggle808Mode();
  };

  const formatPlaylistText = (): string => {
    let text = `PLAYLIST - ${new Date().toLocaleString()}\n`;
    text += `Key: ${KEY_NAMES[playerState.key - 1]} | Tempo: ${playerState.tempo} BPM\n`;
    text += `Total Sets: ${playHistory.length}\n\n`;

    playHistory.forEach((pair, idx) => {
      text += `=== SET ${idx + 1} ===\n`;
      text += `Key: ${KEY_NAMES[pair.key - 1]} | Tempo: ${pair.tempo} BPM\n`;
      text += `1. ${pair.track1.song.artist} - ${pair.track1.song.title}\n`;
      text += `2. ${pair.track2.song.artist} - ${pair.track2.song.title}\n`;
      if (pair.track3) {
        text += `3. ${pair.track3.song.artist} - ${pair.track3.song.title}\n`;
      }
      if (pair.track4) {
        text += `4. ${pair.track4.song.artist} - ${pair.track4.song.title}\n`;
      }
      text += '\n';
    });

    return text;
  };

  const handleCopyPlaylist = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatPlaylistText());
      alert('Playlist copied to clipboard!');
    } catch (err) {
      alert('Failed to copy playlist');
    }
  };

  const handleSaveSettings = (newDisabledSongs: Set<number>): void => {
    setDisabledSongs(newDisabledSongs);
  };

  const handleOpenSettings = (): void => {
    setShowSettings(true);
  };

  const handleRecordToggle = (): void => {
    if (playerState.isRecordingActive) {
      player.stopRecording();
    } else if (playerState.isRecordingArmed) {
      player.disarmRecording();
    } else {
      player.armRecording();
    }
  };

  const formatRecordingTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="app">
      {/* Playback Controls - Top */}
      <div className="controls">
        {(!hasStartedPlaying || playerState.isRecordingArmed || playerState.isRecordingActive) && (
          <button
            className={`ctrl-btn record-btn ${playerState.isRecordingActive ? 'recording' : ''} ${playerState.isRecordingArmed && !playerState.isRecordingActive ? 'recording-armed' : ''}`}
            onClick={handleRecordToggle}
            title={
              playerState.isRecordingActive
                ? 'Stop Recording'
                : playerState.isRecordingArmed
                  ? 'Cancel Recording'
                  : 'Arm Recording'
            }
          >
            ⏺
          </button>
        )}
        {!playerState.isPlaying ? (
          <button className="ctrl-btn play" onClick={handlePlay}>▶︎</button>
        ) : (
          <button className="ctrl-btn" onClick={handlePause}>⏸︎</button>
        )}
        <button className="ctrl-btn" onClick={handleStop}>⏹︎</button>
        <button className="ctrl-btn settings-btn" onClick={handleOpenSettings} title="Settings">
          💿
        </button>
      </div>

      {/* Status Bar */}
      <div className="status-bar">
        <span>{KEY_NAMES[playerState.key - 1]}</span>
        <span>{playerState.tempo} BPM</span>
        <span>{currentTrack === 'intro' ? 'Intro' : 'Main'}</span>
        {playerState.isRecordingActive && (
          <span className="recording-indicator">⏺ {formatRecordingTime(playerState.recordingDuration)}</span>
        )}
        {playerState.isRecordingArmed && !playerState.isRecordingActive && (
          <span className="recording-armed-indicator">⏺ ARMED</span>
        )}
      </div>

      {/* Key Strip */}
      <div className="strip">
        <div className="strip-label">KEY</div>
        <div className="strip-buttons">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((key) => (
            <button
              key={key}
              className={`strip-btn ${playerState.key === key ? 'active' : ''}`}
              onClick={() => handleKeyChange(key as Key)}
            >
              {KEY_NAMES[key - 1]}
            </button>
          ))}
        </div>
      </div>

      {/* Tempo Strip */}
      <div className="strip">
        <div className="strip-label">BPM</div>
        <div className="strip-buttons">
          {ALL_TEMPOS.map((tempo) => (
            <button
              key={tempo}
              className={`strip-btn ${playerState.tempo === tempo ? 'active' : ''}`}
              onClick={() => handleTempoChange(tempo)}
            >
              {tempo}
            </button>
          ))}
          {/* Mannie Fresh Mode Toggle */}
          <div className="mf-toggle-container" style={{ marginLeft: 'auto', paddingLeft: '32px' }}>
            <span className="mf-label">MF</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={playerState.mannieFreshMode}
                onChange={handleMannieFreshToggle}
              />
              <span className="slider"></span>
            </label>
          </div>
          {/* 808 Mode Toggle */}
          <div className="mf-toggle-container" style={{ paddingLeft: '16px' }}>
            <span className="mf-label">808</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={playerState.eightZeroEightMode}
                onChange={handle808Toggle}
              />
              <span className="slider"></span>
            </label>
          </div>
        </div>
      </div>

      {/* Now Playing */}
      {playerState.currentPair && (
        <div className="track-section">
          <div className="section-label">NOW PLAYING</div>
          <div className="track-row compact">
            <div className="track-num">1</div>
            <div className="track-info-compact">
              {playerState.currentPair.track1.song.artist} - {playerState.currentPair.track1.song.title}
            </div>
            <div className="track-key">{KEY_NAMES[playerState.currentPair.track1.song.key - 1]}</div>
          </div>
          <div className="track-row compact">
            <div className="track-num">2</div>
            <div className="track-info-compact">
              {playerState.currentPair.track2.song.artist} - {playerState.currentPair.track2.song.title}
            </div>
            <div className="track-key">{KEY_NAMES[playerState.currentPair.track2.song.key - 1]}</div>
          </div>
          {playerState.currentPair.track3 && (
            <div className={`track-row compact ${
              playerState.eightZeroEightMode
                ? ''
                : (!playerState.mannieFreshMode || (playerState.mannieFreshMode && playerState.activeHiddenTrack !== 3) ? 'inactive-mf' : '')
            }`}>
              <div className="track-num">3</div>
              <div className="track-info-compact">
                {playerState.currentPair.track3.song.artist} - {playerState.currentPair.track3.song.title}
              </div>
              <div className="track-key">{KEY_NAMES[playerState.currentPair.track3.song.key - 1]}</div>
            </div>
          )}
          {playerState.currentPair.track4 && (
            <div className={`track-row compact ${
              playerState.eightZeroEightMode
                ? ''
                : (!playerState.mannieFreshMode || (playerState.mannieFreshMode && playerState.activeHiddenTrack !== 4) ? 'inactive-mf' : '')
            }`}>
              <div className="track-num">4</div>
              <div className="track-info-compact">
                {playerState.currentPair.track4.song.artist} - {playerState.currentPair.track4.song.title}
              </div>
              <div className="track-key">{KEY_NAMES[playerState.currentPair.track4.song.key - 1]}</div>
            </div>
          )}
        </div>
      )}

      {/* Complete Playlist */}
      {completeMix.length > 0 && (
        <div className="playlist-container">
          <div className="playlist-section">
            <div className="section-label played-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '12px', paddingRight: '12px' }}>
              <span>PLAYLIST ({completeMix.length} {completeMix.length === 1 ? 'SET' : 'SETS'})</span>
            </div>
            {completeMix.map((pair, idx) => (
              <div key={`playlist-${idx}`} className="playlist-pair played">
                <div className="pair-meta">
                  <span className="pair-key">{KEY_NAMES[pair.key - 1]}</span>
                  <span className="pair-tempo">{pair.tempo}</span>
                </div>
                <div className="pair-tracks">
                  <div className="playlist-track">
                    1. {pair.track1.song.artist} - {pair.track1.song.title}
                  </div>
                  <div className="playlist-track">
                    2. {pair.track2.song.artist} - {pair.track2.song.title}
                  </div>
                  {pair.track3 && (
                    <div className="playlist-track">
                      3. {pair.track3.song.artist} - {pair.track3.song.title}
                    </div>
                  )}
                  {pair.track4 && (
                    <div className="playlist-track">
                      4. {pair.track4.song.artist} - {pair.track4.song.title}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Play History */}
      {playHistory.length > 0 && (
        <div className="playlist-container">
          <div className="playlist-section">
            <div className="section-label played-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '12px', paddingRight: '12px' }}>
              <span>HISTORY ({playHistory.length} {playHistory.length === 1 ? 'SET' : 'SETS'})</span>
              <button className="playlist-btn-small" onClick={handleCopyPlaylist} title="Copy to clipboard">
                Copy
              </button>
            </div>
            {playHistory.map((pair, idx) => (
              <div key={`played-${idx}`} className="playlist-pair played">
                <div className="pair-meta">
                  <span className="pair-key">{KEY_NAMES[pair.key - 1]}</span>
                  <span className="pair-tempo">{pair.tempo}</span>
                </div>
                <div className="pair-tracks">
                  <div className="playlist-track">
                    1. {pair.track1.song.artist} - {pair.track1.song.title}
                  </div>
                  <div className="playlist-track">
                    2. {pair.track2.song.artist} - {pair.track2.song.title}
                  </div>
                  {pair.track3 && (
                    <div className="playlist-track">
                      3. {pair.track3.song.artist} - {pair.track3.song.title}
                    </div>
                  )}
                  {pair.track4 && (
                    <div className="playlist-track">
                      4. {pair.track4.song.artist} - {pair.track4.song.title}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showSettings}
        songs={[...songs]}
        onClose={() => setShowSettings(false)}
        onSave={handleSaveSettings}
      />
    </div>
  );
}

export default App;
