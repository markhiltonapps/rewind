'use client';

import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { useCallback, useEffect, useState, useRef } from 'react';
import { Play, Pause, Square, Mic } from 'lucide-react';
import { ProcessRequest, SummaryResponse } from '@/types/summary';

type RecorderState = 'Idle' | 'Potential' | 'Recording' | 'Finalizing';

interface RecordingControlsProps {
  isRecording: boolean;
  barHeights: string[];
  onRecordingStop: () => void;
  onRecordingStart: () => void;
  onTranscriptReceived: (summary: SummaryResponse) => void;
  recorderState?: RecorderState;
}

export const RecordingControls: React.FC<RecordingControlsProps> = ({
  isRecording,
  barHeights,
  onRecordingStop,
  onRecordingStart,
  onTranscriptReceived,
  recorderState = 'Idle',
}) => {
  const [showPlayback, setShowPlayback] = useState(false);
  const [recordingPath, setRecordingPath] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [stopCountdown, setStopCountdown] = useState(5);
  const countdownInterval = useRef<NodeJS.Timeout | null>(null);
  const stopTimeoutRef = useRef<{ stop: () => void } | null>(null);
  const MIN_RECORDING_DURATION = 2000; // 2 seconds minimum recording time

  const currentTime = 0;
  const duration = 0;
  const isPlaying = false;
  const progress = 0;

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    const checkTauri = async () => {
      try {
        const result = await invoke('is_recording');
        console.log('Tauri is initialized and ready, is_recording result:', result);
      } catch (error) {
        console.error('Tauri initialization error:', error);
        alert('Failed to initialize recording. Please check the console for details.');
      }
    };
    checkTauri();
  }, []);

  const handleStartRecording = useCallback(async () => {
    if (isStarting) return;
    console.log('Starting recording...');
    setIsStarting(true);
    setShowPlayback(false);
    setTranscript(''); // Clear any previous transcript
    
    try {
      // Phase 2a: dispatch through the state machine so manual + auto
      // recordings share the same FSM/lifecycle.
      await invoke('manual_start');
      console.log('manual_start dispatched');
      setIsProcessing(false);
      onRecordingStart();
    } catch (error) {
      console.error('Failed to start recording:', error);
      alert('Failed to start recording. Please check the console for details.');
    } finally {
      setIsStarting(false);
    }
  }, [onRecordingStart, isStarting]);

  const stopRecordingAction = useCallback(async () => {
    console.log('Executing stop recording...');
    try {
      setIsProcessing(true);
      const dataDir = await appDataDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const savePath = `${dataDir}/recording-${timestamp}.wav`;

      // Phase 2a: persist the transcript BEFORE dispatching manual_stop.
      // The save is what the parent's onRecordingStop actually does
      // (POST /save-transcript), and it must read the transcripts state at
      // its freshest. manual_stop only flips FSM state and starts the 30s
      // drain — order doesn't matter for it.
      onRecordingStop();

      console.log('Dispatching manual_stop; FSM will handle the drain + stop.');
      await invoke('manual_stop');

      setRecordingPath(savePath);
      setIsProcessing(false);
    } catch (error) {
      console.error('Failed to stop recording:', error);
      if (error instanceof Error) {
        console.error('Error details:', {
          message: error.message,
          name: error.name,
          stack: error.stack,
        });
        if (error.message.includes('No recording in progress')) {
          return;
        }
      } else if (typeof error === 'string' && error.includes('No recording in progress')) {
        return;
      } else if (error && typeof error === 'object' && 'toString' in error) {
        if (error.toString().includes('No recording in progress')) {
          return;
        }
      }
      setIsProcessing(false);
      onRecordingStop();
    } finally {
      setIsStopping(false);
    }
  }, [onRecordingStop]);

  const handleStopRecording = useCallback(async () => {
    if (!isRecording || isStarting || isStopping) return;
    // Phase 2a: drop the 5-second countdown. The FSM has its own 30s
    // FINALIZING drain that gives the recording a graceful grace period;
    // the countdown duplicates that and (worse) keeps a stale closure
    // around the setInterval callback that was binding stopRecordingAction
    // to a possibly-empty transcripts state.
    setIsStopping(true);
    await stopRecordingAction();
  }, [isRecording, isStarting, isStopping, stopRecordingAction]);

  const cancelStopRecording = useCallback(() => {
    if (stopTimeoutRef.current) {
      stopTimeoutRef.current.stop();
      stopTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (countdownInterval.current) clearInterval(countdownInterval.current);
      if (stopTimeoutRef.current) stopTimeoutRef.current.stop();
    };
  }, []);

  return (
    <div className="flex flex-col space-y-2">
      <div className="flex items-center space-x-2 bg-white rounded-full shadow-lg px-4 py-2">
        {isProcessing ? (
          <div className="flex items-center space-x-2">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-900"></div>
            <span className="text-sm text-gray-600">Processing recording...</span>
          </div>
        ) : (
          <>
            {showPlayback ? (
              <>
                <button
                  onClick={handleStartRecording}
                  className="w-10 h-10 flex items-center justify-center bg-red-500 rounded-full text-white hover:bg-red-600 transition-colors"
                >
                  <Mic size={16} />
                </button>

                <div className="w-px h-6 bg-gray-200 mx-1" />

                <div className="flex items-center space-x-1 mx-2">
                  <div className="text-sm text-gray-600 min-w-[40px]">
                    {formatTime(currentTime)}
                  </div>
                  <div 
                    className="relative w-24 h-1 bg-gray-200 rounded-full"
                  >
                    <div 
                      className="absolute h-full bg-blue-500 rounded-full" 
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <div className="text-sm text-gray-600 min-w-[40px]">
                    {formatTime(duration)}
                  </div>
                </div>

                <button 
                  className="w-10 h-10 flex items-center justify-center bg-gray-300 rounded-full text-white cursor-not-allowed"
                  disabled
                >
                  <Play size={16} />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={isRecording ?
                    (isStopping ? cancelStopRecording : handleStopRecording) :
                    handleStartRecording}
                  disabled={isStarting || isProcessing || recorderState === 'Finalizing'}
                  className={`w-12 h-12 flex items-center justify-center ${
                    isStarting || isProcessing || recorderState === 'Finalizing'
                      ? 'bg-gray-400 cursor-not-allowed'
                      : 'bg-red-500 hover:bg-red-600'
                  } rounded-full text-white transition-colors relative`}
                  title={recorderState === 'Finalizing' ? 'Finishing previous recording…' : undefined}
                >
                  {isRecording ? (
                    <>
                      <Square size={20} />
                      {isStopping && (
                        <div className="absolute -top-8 text-red-500 font-medium">
                          {stopCountdown > 0 ? `${stopCountdown}s` : 'Stopping...'}
                        </div>
                      )}
                    </>
                  ) : (
                    <Mic size={20} />
                  )}
                </button>

                <div className="flex items-center space-x-1 mx-4">
                  {barHeights.map((height, index) => (
                    <div
                      key={index}
                      className="w-1 bg-red-500 rounded-full transition-all duration-200"
                      style={{
                        height: isRecording ? height : '4px',
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {/* {showPlayback && recordingPath && (
        <div className="text-sm text-gray-600 px-4">
          Recording saved to: {recordingPath}
        </div>
      )} */}
    </div>
  );
};