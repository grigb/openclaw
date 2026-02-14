#!/usr/bin/env python3
"""
Voice Channel MVP - Phase 1 Implementation
Real-time voice-to-voice AI conversation using:
- Whisper for STT (tiny/base models)
- Ollama (Qwen2.5:7b) for LLM
- Piper TTS for speech synthesis
- Silero VAD for voice activity detection

Target latency: <1 second end-to-end
"""

import asyncio
import audioop
import io
import json
import logging
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import wave
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import requests
import sounddevice as sd
import torch

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('voice_channel')


@dataclass
class VoiceChannelConfig:
    """Configuration for the voice channel."""
    # Audio settings
    sample_rate: int = 16000
    chunk_duration_ms: int = 30
    channels: int = 1
    
    # STT settings (Whisper)
    whisper_model: str = "tiny"  # tiny, base, small
    whisper_language: str = "en"
    
    # LLM settings (Ollama)
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5:7b"
    max_context_tokens: int = 2048
    
    # TTS settings (Piper)
    piper_model: str = "en_US-lessac-medium"
    piper_model_path: Optional[str] = None
    
    # VAD settings (Silero)
    vad_threshold: float = 0.5
    vad_min_silence_ms: int = 500
    vad_speech_pad_ms: int = 100
    
    # Performance settings
    enable_interruptions: bool = True
    max_latency_ms: int = 1000
    keep_warm: bool = True
    
    def __post_init__(self):
        self.chunk_samples = int(self.sample_rate * self.chunk_duration_ms / 1000)


@dataclass
class TimingMetrics:
    """Track timing metrics for each conversation turn."""
    turn_id: int
    vad_start_ms: float = 0
    stt_start_ms: float = 0
    stt_end_ms: float = 0
    llm_start_ms: float = 0
    llm_ttfb_ms: float = 0
    llm_end_ms: float = 0
    tts_start_ms: float = 0
    tts_first_chunk_ms: float = 0
    tts_end_ms: float = 0
    total_latency_ms: float = 0
    
    def summary(self) -> str:
        stt_latency = self.stt_end_ms - self.stt_start_ms
        llm_ttfb = self.llm_ttfb_ms - self.llm_start_ms
        llm_total = self.llm_end_ms - self.llm_start_ms
        tts_latency = self.tts_end_ms - self.tts_start_ms
        
        return (
            f"Turn {self.turn_id}: "
            f"STT={stt_latency:.0f}ms, "
            f"LLM_TTFB={llm_ttfb:.0f}ms, "
            f"LLM_Total={llm_total:.0f}ms, "
            f"TTS={tts_latency:.0f}ms, "
            f"E2E={self.total_latency_ms:.0f}ms"
        )


class SileroVAD:
    """Voice Activity Detection using Silero VAD model."""
    
    def __init__(self, threshold: float = 0.5, sample_rate: int = 16000):
        self.threshold = threshold
        self.sample_rate = sample_rate
        self.model, self.utils = self._load_model()
        self.get_speech_timestamps = self.utils[0]
        
    def _load_model(self):
        """Load the Silero VAD model."""
        try:
            model, utils = torch.hub.load(
                repo_or_dir='snakers4/silero-vad',
                model='silero_vad',
                force_reload=False,
                onnx=False
            )
            logger.info("Silero VAD model loaded")
            return model, utils
        except Exception as e:
            logger.error(f"Failed to load Silero VAD: {e}")
            # Fallback to energy-based VAD
            return None, None
    
    def is_speech(self, audio_chunk: np.ndarray) -> bool:
        """Check if audio chunk contains speech."""
        if self.model is None:
            # Fallback: simple energy-based detection
            energy = np.sqrt(np.mean(audio_chunk ** 2))
            return energy > 0.01
        
        # Convert to tensor
        tensor = torch.from_numpy(audio_chunk).float()
        
        # Get speech probability
        with torch.no_grad():
            speech_prob = self.model(tensor, self.sample_rate).item()
        
        return speech_prob > self.threshold


class WhisperSTT:
    """Speech-to-Text using OpenAI Whisper."""
    
    def __init__(self, model_name: str = "tiny", language: str = "en"):
        self.model_name = model_name
        self.language = language
        self.model = None
        self._load_model()
        
    def _load_model(self):
        """Load the Whisper model."""
        try:
            import whisper
            logger.info(f"Loading Whisper model: {self.model_name}")
            start = time.time()
            self.model = whisper.load_model(self.model_name)
            load_time = (time.time() - start) * 1000
            logger.info(f"Whisper model loaded in {load_time:.0f}ms")
        except ImportError:
            logger.error("whisper package not installed. Run: pip install openai-whisper")
            raise
        except Exception as e:
            logger.error(f"Failed to load Whisper model: {e}")
            raise
    
    def transcribe(self, audio_data: np.ndarray, sample_rate: int = 16000) -> str:
        """Transcribe audio to text."""
        if self.model is None:
            return ""
        
        try:
            result = self.model.transcribe(
                audio_data,
                language=self.language,
                fp16=False,
                condition_on_previous_text=False
            )
            return result.get("text", "").strip()
        except Exception as e:
            logger.error(f"Transcription error: {e}")
            return ""


class OllamaLLM:
    """LLM client using Ollama API."""
    
    def __init__(self, base_url: str = "http://localhost:11434", model: str = "qwen2.5:7b"):
        self.base_url = base_url.rstrip('/')
        self.model = model
        self.context = []
        self._warm_up()
    
    def _warm_up(self):
        """Warm up the model to reduce cold start latency."""
        logger.info(f"Warming up {self.model}...")
        try:
            response = requests.post(
                f"{self.base_url}/api/generate",
                json={
                    "model": self.model,
                    "prompt": "Hello",
                    "stream": False,
                    "options": {"num_predict": 1}
                },
                timeout=60
            )
            if response.status_code == 200:
                logger.info("Model warmed up successfully")
            else:
                logger.warning(f"Warm-up returned status {response.status_code}")
        except Exception as e:
            logger.warning(f"Model warm-up failed: {e}")
    
    def generate(self, prompt: str, stream_callback: Optional[Callable[[str], None]] = None) -> str:
        """Generate response from LLM."""
        # Add to context
        self.context.append({"role": "user", "content": prompt})
        
        # Build prompt with context
        full_prompt = self._build_prompt()
        
        try:
            response = requests.post(
                f"{self.base_url}/api/generate",
                json={
                    "model": self.model,
                    "prompt": full_prompt,
                    "stream": True,
                    "options": {
                        "num_ctx": 2048,
                        "temperature": 0.7,
                        "num_predict": 150
                    }
                },
                stream=True,
                timeout=60
            )
            
            if response.status_code != 200:
                logger.error(f"Ollama error: {response.status_code}")
                return "I'm sorry, I couldn't process that."
            
            full_response = ""
            for line in response.iter_lines():
                if line:
                    try:
                        data = json.loads(line)
                        token = data.get("response", "")
                        full_response += token
                        
                        if stream_callback and token:
                            stream_callback(token)
                        
                        if data.get("done", False):
                            break
                    except json.JSONDecodeError:
                        continue
            
            # Add response to context
            self.context.append({"role": "assistant", "content": full_response})
            
            # Trim context if too long
            self._trim_context()
            
            return full_response.strip()
            
        except Exception as e:
            logger.error(f"LLM generation error: {e}")
            return "I'm sorry, I encountered an error."
    
    def _build_prompt(self) -> str:
        """Build prompt from context."""
        # Simple context building - can be enhanced
        if len(self.context) == 1:
            return self.context[0]["content"]
        
        # Format as conversation
        prompt = ""
        for msg in self.context[-6:]:  # Keep last 6 exchanges
            if msg["role"] == "user":
                prompt += f"User: {msg['content']}\n"
            else:
                prompt += f"Assistant: {msg['content']}\n"
        prompt += "Assistant:"
        return prompt
    
    def _trim_context(self, max_exchanges: int = 10):
        """Trim context to prevent it from growing too large."""
        if len(self.context) > max_exchanges * 2:
            self.context = self.context[-max_exchanges * 2:]


class PiperTTS:
    """Text-to-Speech using Piper."""
    
    def __init__(self, model_name: str = "en_US-lessac-medium", model_path: Optional[str] = None):
        self.model_name = model_name
        self.model_path = model_path or self._find_model(model_name)
        self.sample_rate = 22050  # Piper default
        
    def _find_model(self, model_name: str) -> str:
        """Find Piper model file."""
        # Common locations
        search_paths = [
            Path.home() / ".local" / "share" / "piper" / f"{model_name}.onnx",
            Path.home() / "piper" / "models" / f"{model_name}.onnx",
            Path("/usr/local/share/piper") / f"{model_name}.onnx",
            Path("/opt/piper/models") / f"{model_name}.onnx",
        ]
        
        for path in search_paths:
            if path.exists():
                logger.info(f"Found Piper model: {path}")
                return str(path)
        
        # If not found, return the name and hope it's in PATH
        logger.warning(f"Piper model not found in common locations. Will try: {model_name}")
        return model_name
    
    def synthesize(self, text: str) -> np.ndarray:
        """Synthesize text to audio."""
        try:
            # Use piper command-line tool
            cmd = [
                "piper",
                "--model", self.model_path,
                "--output_file", "-",  # Output to stdout
                "--json-input"
            ]
            
            input_data = json.dumps({"text": text})
            
            result = subprocess.run(
                cmd,
                input=input_data.encode(),
                capture_output=True,
                timeout=10
            )
            
            if result.returncode != 0:
                logger.error(f"Piper error: {result.stderr.decode()}")
                return self._fallback_tts(text)
            
            # Parse WAV output
            audio = self._parse_wav(result.stdout)
            return audio
            
        except FileNotFoundError:
            logger.warning("Piper not found, using fallback TTS")
            return self._fallback_tts(text)
        except Exception as e:
            logger.error(f"TTS synthesis error: {e}")
            return self._fallback_tts(text)
    
    def _parse_wav(self, wav_data: bytes) -> np.ndarray:
        """Parse WAV data to numpy array."""
        with io.BytesIO(wav_data) as wav_io:
            with wave.open(wav_io, 'rb') as wav_file:
                n_channels = wav_file.getnchannels()
                sample_width = wav_file.getsampwidth()
                n_frames = wav_file.getnframes()
                
                frames = wav_file.readframes(n_frames)
                
                # Convert to numpy
                if sample_width == 2:
                    audio = np.frombuffer(frames, dtype=np.int16)
                elif sample_width == 4:
                    audio = np.frombuffer(frames, dtype=np.int32)
                else:
                    audio = np.frombuffer(frames, dtype=np.int8)
                
                # Normalize to float32
                audio = audio.astype(np.float32) / 32768.0
                
                # Convert stereo to mono if needed
                if n_channels == 2:
                    audio = audio.reshape(-1, 2).mean(axis=1)
                
                return audio
    
    def _fallback_tts(self, text: str) -> np.ndarray:
        """Fallback to macOS say command."""
        try:
            with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as f:
                temp_path = f.name
            
            # Use macOS say command
            subprocess.run(
                ["say", "-o", temp_path, text],
                check=True,
                timeout=10
            )
            
            # Convert to wav using afconvert
            wav_path = temp_path.replace(".aiff", ".wav")
            subprocess.run(
                ["afconvert", "-f", "WAVE", "-d", "LEI16", temp_path, wav_path],
                check=True,
                timeout=5
            )
            
            # Read wav file
            with wave.open(wav_path, 'rb') as wav_file:
                frames = wav_file.readframes(wav_file.getnframes())
                audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
            
            # Clean up
            os.unlink(temp_path)
            os.unlink(wav_path)
            
            return audio
            
        except Exception as e:
            logger.error(f"Fallback TTS failed: {e}")
            # Return silence
            return np.zeros(int(self.sample_rate * 0.5), dtype=np.float32)
    
    def synthesize_streaming(self, text: str, chunk_callback: Callable[[np.ndarray], None]):
        """Synthesize text in streaming mode (chunk by chunk)."""
        # For now, just synthesize and split into chunks
        # True streaming would require Piper's streaming API
        audio = self.synthesize(text)
        
        chunk_size = int(self.sample_rate * 0.1)  # 100ms chunks
        for i in range(0, len(audio), chunk_size):
            chunk = audio[i:i + chunk_size]
            chunk_callback(chunk)


class VoiceChannel:
    """Main voice channel orchestrator."""
    
    def __init__(self, config: Optional[VoiceChannelConfig] = None):
        self.config = config or VoiceChannelConfig()
        self.metrics_history: deque = deque(maxlen=100)
        self.turn_counter = 0
        self.is_running = False
        self.is_speaking = False
        self.interrupt_requested = False
        
        # Initialize components
        logger.info("Initializing Voice Channel components...")
        self.vad = SileroVAD(
            threshold=self.config.vad_threshold,
            sample_rate=self.config.sample_rate
        )
        self.stt = WhisperSTT(
            model_name=self.config.whisper_model,
            language=self.config.whisper_language
        )
        self.llm = OllamaLLM(
            base_url=self.config.ollama_url,
            model=self.config.ollama_model
        )
        self.tts = PiperTTS(
            model_name=self.config.piper_model,
            model_path=self.config.piper_model_path
        )
        
        # Audio buffers
        self.audio_buffer = []
        self.silence_frames = 0
        self.max_silence_frames = int(self.config.vad_min_silence_ms / self.config.chunk_duration_ms)
        
        logger.info("Voice Channel initialized successfully")
    
    def start(self):
        """Start the voice channel."""
        logger.info("Starting Voice Channel...")
        self.is_running = True
        
        # Start audio capture
        try:
            with sd.InputStream(
                samplerate=self.config.sample_rate,
                channels=self.config.channels,
                dtype=np.float32,
                blocksize=self.config.chunk_samples,
                callback=self._audio_callback
            ):
                logger.info("Audio capture started. Listening...")
                print("\n🎤 Voice Channel Active - Speak to start conversation")
                print("Press Ctrl+C to exit\n")
                
                while self.is_running:
                    time.sleep(0.1)
                    
        except KeyboardInterrupt:
            logger.info("Interrupted by user")
        finally:
            self.stop()
    
    def stop(self):
        """Stop the voice channel."""
        logger.info("Stopping Voice Channel...")
        self.is_running = False
        self._print_metrics_summary()
    
    def _audio_callback(self, indata, frames, time_info, status):
        """Callback for audio input."""
        if status:
            logger.warning(f"Audio status: {status}")
        
        # Flatten audio data
        audio_chunk = indata.flatten()
        
        # Check for speech
        is_speech = self.vad.is_speech(audio_chunk)
        
        if is_speech:
            if not self.is_speaking and len(self.audio_buffer) == 0:
                # Start of speech detected
                logger.debug("Speech started")
            
            self.audio_buffer.append(audio_chunk)
            self.silence_frames = 0
            
            # Check for interruption
            if self.is_speaking and self.config.enable_interruptions:
                self._handle_interruption()
                
        else:
            if len(self.audio_buffer) > 0:
                self.silence_frames += 1
                self.audio_buffer.append(audio_chunk)
                
                if self.silence_frames >= self.max_silence_frames:
                    # End of speech detected
                    self._process_utterance()
                    self.audio_buffer = []
                    self.silence_frames = 0
    
    def _handle_interruption(self):
        """Handle user interruption (barge-in)."""
        logger.info("Interruption detected!")
        self.interrupt_requested = True
        sd.stop()  # Stop current playback
        self.is_speaking = False
    
    def _process_utterance(self):
        """Process a complete user utterance."""
        self.turn_counter += 1
        metrics = TimingMetrics(turn_id=self.turn_counter)
        
        logger.info(f"\n--- Processing Turn {self.turn_counter} ---")
        
        # Concatenate audio buffer
        audio_data = np.concatenate(self.audio_buffer)
        
        # 1. Speech-to-Text
        metrics.stt_start_ms = time.time() * 1000
        text = self.stt.transcribe(audio_data, self.config.sample_rate)
        metrics.stt_end_ms = time.time() * 1000
        
        if not text:
            logger.info("No speech detected")
            return
        
        logger.info(f"User: {text}")
        logger.info(f"STT latency: {metrics.stt_end_ms - metrics.stt_start_ms:.0f}ms")
        
        # 2. LLM Generation
        metrics.llm_start_ms = time.time() * 1000
        
        response_buffer = []
        def on_token(token: str):
            response_buffer.append(token)
            if len(response_buffer) == 1:
                metrics.llm_ttfb_ms = time.time() * 1000
        
        response = self.llm.generate(text, stream_callback=on_token)
        metrics.llm_end_ms = time.time() * 1000
        
        logger.info(f"AI: {response}")
        logger.info(f"LLM TTFB: {metrics.llm_ttfb_ms - metrics.llm_start_ms:.0f}ms")
        logger.info(f"LLM total: {metrics.llm_end_ms - metrics.llm_start_ms:.0f}ms")
        
        # 3. Text-to-Speech
        metrics.tts_start_ms = time.time() * 1000
        self.is_speaking = True
        self.interrupt_requested = False
        
        audio_response = self.tts.synthesize(response)
        metrics.tts_end_ms = time.time() * 1000
        
        # Calculate total latency
        metrics.total_latency_ms = metrics.tts_end_ms - metrics.stt_start_ms
        
        logger.info(f"TTS latency: {metrics.tts_end_ms - metrics.tts_start_ms:.0f}ms")
        logger.info(f"End-to-end latency: {metrics.total_latency_ms:.0f}ms")
        
        # Store metrics
        self.metrics_history.append(metrics)
        
        # Play audio response (if not interrupted)
        if not self.interrupt_requested:
            self._play_audio(audio_response)
        
        self.is_speaking = False
        logger.info(f"--- Turn {self.turn_counter} Complete ---\n")
    
    def _play_audio(self, audio: np.ndarray):
        """Play audio through speakers."""
        try:
            # Resample if needed (Piper uses 22050, system might use 16000)
            if self.tts.sample_rate != self.config.sample_rate:
                # Simple resampling
                ratio = self.config.sample_rate / self.tts.sample_rate
                new_length = int(len(audio) / ratio)
                audio = np.interp(
                    np.linspace(0, len(audio), new_length),
                    np.arange(len(audio)),
                    audio
                )
            
            sd.play(audio, self.config.sample_rate)
            sd.wait()
        except Exception as e:
            logger.error(f"Audio playback error: {e}")
    
    def _print_metrics_summary(self):
        """Print summary of performance metrics."""
        if not self.metrics_history:
            return
        
        print("\n" + "=" * 50)
        print("PERFORMANCE SUMMARY")
        print("=" * 50)
        
        stt_latencies = [m.stt_end_ms - m.stt_start_ms for m in self.metrics_history]
        llm_ttfs = [m.llm_ttfb_ms - m.llm_start_ms for m in self.metrics_history if m.llm_ttfb_ms > 0]
        llm_totals = [m.llm_end_ms - m.llm_start_ms for m in self.metrics_history]
        tts_latencies = [m.tts_end_ms - m.tts_start_ms for m in self.metrics_history]
        e2e_latencies = [m.total_latency_ms for m in self.metrics_history]
        
        print(f"Turns processed: {len(self.metrics_history)}")
        print(f"\nSTT latency:     avg={sum(stt_latencies)/len(stt_latencies):.0f}ms, max={max(stt_latencies):.0f}ms")
        print(f"LLM TTFB:        avg={sum(llm_ttfs)/len(llm_ttfs):.0f}ms, max={max(llm_ttfs):.0f}ms")
        print(f"LLM total:       avg={sum(llm_totals)/len(llm_totals):.0f}ms, max={max(llm_totals):.0f}ms")
        print(f"TTS latency:     avg={sum(tts_latencies)/len(tts_latencies):.0f}ms, max={max(tts_latencies):.0f}ms")
        print(f"End-to-end:      avg={sum(e2e_latencies)/len(e2e_latencies):.0f}ms, max={max(e2e_latencies):.0f}ms")
        
        # Check against targets
        print("\n" + "-" * 50)
        print("TARGET COMPLIANCE")
        print("-" * 50)
        
        targets = {
            "STT < 300ms": sum(1 for l in stt_latencies if l < 300) / len(stt_latencies) * 100,
            "LLM TTFB < 500ms": sum(1 for l in llm_ttfs if l < 500) / len(llm_ttfs) * 100,
            "TTS < 200ms": sum(1 for l in tts_latencies if l < 200) / len(tts_latencies) * 100,
            "E2E < 1000ms": sum(1 for l in e2e_latencies if l < 1000) / len(e2e_latencies) * 100,
        }
        
        for target, pct in targets.items():
            status = "✅" if pct >= 80 else "⚠️" if pct >= 50 else "❌"
            print(f"{status} {target}: {pct:.0f}% of turns")
        
        print("=" * 50)


def main():
    """Main entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Voice Channel MVP")
    parser.add_argument("--whisper-model", default="tiny", help="Whisper model (tiny, base, small)")
    parser.add_argument("--ollama-model", default="qwen2.5:7b", help="Ollama model name")
    parser.add_argument("--piper-model", default="en_US-lessac-medium", help="Piper TTS model")
    parser.add_argument("--no-interruptions", action="store_true", help="Disable interruptions")
    parser.add_argument("--vad-threshold", type=float, default=0.5, help="VAD threshold")
    
    args = parser.parse_args()
    
    config = VoiceChannelConfig(
        whisper_model=args.whisper_model,
        ollama_model=args.ollama_model,
        piper_model=args.piper_model,
        enable_interruptions=not args.no_interruptions,
        vad_threshold=args.vad_threshold
    )
    
    channel = VoiceChannel(config)
    channel.start()


if __name__ == "__main__":
    main()
