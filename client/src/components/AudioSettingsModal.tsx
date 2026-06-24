import { useAudioStore } from '../store/useAudioStore';
import type { DuckingSpeed, AudioMode } from '../store/useAudioStore';
import { X, Volume2, Settings2 } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function AudioSettingsModal({ isOpen, onClose }: Props) {
  const { settings, updateSettings } = useAudioStore();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/80">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Settings2 size={20} className="text-indigo-400" />
            Audio Settings
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
          {/* Global Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-slate-200">Smart Volume Lowering</h3>
              <p className="text-sm text-slate-400">Automatically lower movie volume when people speak</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" className="sr-only peer" checked={settings.isEnabled} onChange={(e) => updateSettings({ isEnabled: e.target.checked })} />
              <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            </label>
          </div>

          {settings.isEnabled && (
            <>
              {/* Audio Modes */}
              <div className="space-y-3">
                <h3 className="font-semibold text-slate-200">Audio Profile</h3>
                <div className="grid grid-cols-2 gap-2">
                  {(['cinema', 'balanced', 'conversation', 'custom'] as AudioMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => updateSettings({ audioMode: mode })}
                      className={`p-2 rounded-lg border text-sm capitalize font-medium transition-all ${settings.audioMode === mode ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300' : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800'}`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* Ducking Level */}
              <div className="space-y-3">
                <div className="flex justify-between">
                  <h3 className="font-semibold text-slate-200">Volume Reduction Amount</h3>
                  <span className="text-indigo-400 font-mono text-sm">{Math.round(settings.duckingLevel * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={settings.duckingLevel}
                  onChange={(e) => updateSettings({ duckingLevel: parseFloat(e.target.value) })}
                  className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  disabled={settings.audioMode !== 'custom'}
                />
                <div className="flex justify-between text-xs text-slate-500">
                  <span>Subtle</span>
                  <span>Strong</span>
                </div>
              </div>

              {/* Speeds */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-slate-200">Lowering Speed</h3>
                  <select 
                    value={settings.duckingSpeed} 
                    onChange={(e) => updateSettings({ duckingSpeed: e.target.value as DuckingSpeed })}
                    disabled={settings.audioMode !== 'custom'}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm text-slate-300 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="slow">Slow</option>
                    <option value="normal">Normal</option>
                    <option value="fast">Fast</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-slate-200">Recovery Speed</h3>
                  <select 
                    value={settings.recoverySpeed} 
                    onChange={(e) => updateSettings({ recoverySpeed: e.target.value as DuckingSpeed })}
                    disabled={settings.audioMode !== 'custom'}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm text-slate-300 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="slow">Slow</option>
                    <option value="normal">Normal</option>
                    <option value="fast">Fast</option>
                  </select>
                </div>
              </div>

              {/* Custom Base Volumes */}
              {settings.audioMode === 'custom' && (
                <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <h4 className="text-sm font-medium text-slate-300 flex items-center gap-2"><Volume2 size={14}/> Movie Base Volume</h4>
                      <span className="text-xs text-slate-500">{Math.round(settings.customMovieVolume * 100)}%</span>
                    </div>
                    <input type="range" min="0" max="1" step="0.05" value={settings.customMovieVolume} onChange={(e) => updateSettings({ customMovieVolume: parseFloat(e.target.value) })} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
