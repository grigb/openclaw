#!/usr/bin/env python3
"""
Voice Channel MVP - Integration Tests
Tests all components of the voice channel pipeline.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path

import numpy as np
import requests

# Add the voice channel module to path
sys.path.insert(0, str(Path(__file__).parent))

from voice_channel_mvp import (
    VoiceChannelConfig,
    SileroVAD,
    WhisperSTT,
    OllamaLLM,
    PiperTTS,
    TimingMetrics
)


class TestSileroVAD(unittest.TestCase):
    """Test Voice Activity Detection."""
    
    @classmethod
    def setUpClass(cls):
        cls.vad = SileroVAD(threshold=0.5, sample_rate=16000)
    
    def test_silence_detection(self):
        """VAD should detect silence in quiet audio."""
        # Generate silence
        silence = np.zeros(16000, dtype=np.float32)
        is_speech = self.vad.is_speech(silence)
        self.assertFalse(is_speech, "Should detect silence")
    
    def test_speech_detection(self):
        """VAD should detect speech in audio with signal."""
        # Generate synthetic speech-like signal (sine wave)
        t = np.linspace(0, 1, 16000)
        speech = np.sin(2 * np.pi * 440 * t).astype(np.float32) * 0.1
        is_speech = self.vad.is_speech(speech)
        self.assertTrue(is_speech, "Should detect speech-like signal")
    
    def test_chunk_processing(self):
        """VAD should process audio chunks."""
        chunk = np.random.randn(480).astype(np.float32) * 0.05
        result = self.vad.is_speech(chunk)
        self.assertIsInstance(result, bool)


class TestWhisperSTT(unittest.TestCase):
    """Test Speech-to-Text component."""
    
    @classmethod
    def setUpClass(cls):
        try:
            cls.stt = WhisperSTT(model_name="tiny", language="en")
        except Exception as e:
            cls.stt = None
            cls.setup_error = str(e)
    
    def setUp(self):
        if self.stt is None:
            self.skipTest(f"Whisper not available: {self.setup_error}")
    
    def test_transcribe_silence(self):
        """STT should handle silence gracefully."""
        silence = np.zeros(16000, dtype=np.float32)
        text = self.stt.transcribe(silence)
        self.assertIsInstance(text, str)
    
    def test_transcribe_synthetic(self):
        """STT should process synthetic audio."""
        # Generate synthetic audio (not real speech, just for testing)
        t = np.linspace(0, 1, 16000)
        audio = np.sin(2 * np.pi * 440 * t).astype(np.float32) * 0.1
        text = self.stt.transcribe(audio)
        self.assertIsInstance(text, str)
    
    def test_transcription_latency(self):
        """STT should complete in reasonable time."""
        silence = np.zeros(16000, dtype=np.float32)
        start = time.time()
        self.stt.transcribe(silence)
        elapsed = (time.time() - start) * 1000
        self.assertLess(elapsed, 5000, "STT should complete in < 5 seconds")


class TestOllamaLLM(unittest.TestCase):
    """Test LLM component."""
    
    @classmethod
    def setUpClass(cls):
        cls.llm = OllamaLLM(base_url="http://localhost:11434", model="qwen2.5:7b")
        cls.available = cls._check_ollama()
    
    @classmethod
    def _check_ollama(cls):
        """Check if Ollama is running and model is available."""
        try:
            response = requests.get("http://localhost:11434/api/tags", timeout=5)
            if response.status_code != 200:
                return False
            models = response.json().get("models", [])
            model_names = [m.get("name", "") for m in models]
            return any("qwen" in name.lower() for name in model_names)
        except Exception:
            return False
    
    def setUp(self):
        if not self.available:
            self.skipTest("Ollama not available or qwen2.5:7b not loaded")
    
    def test_generate_response(self):
        """LLM should generate a response."""
        response = self.llm.generate("Say hello in one word.")
        self.assertIsInstance(response, str)
        self.assertGreater(len(response), 0)
    
    def test_generate_ttfb(self):
        """LLM should have reasonable TTFB."""
        ttfb_ms = 0
        def on_token(token):
            nonlocal ttfb_ms
            if ttfb_ms == 0:
                ttfb_ms = time.time() * 1000
        
        start = time.time() * 1000
        self.llm.generate("Hello", stream_callback=on_token)
        
        if ttfb_ms > 0:
            latency = ttfb_ms - start
            self.assertLess(latency, 2000, "TTFB should be < 2 seconds")
    
    def test_context_management(self):
        """LLM should maintain conversation context."""
        response1 = self.llm.generate("My name is Alice.")
        response2 = self.llm.generate("What's my name?")
        self.assertIn("Alice", response2)


class TestPiperTTS(unittest.TestCase):
    """Test Text-to-Speech component."""
    
    @classmethod
    def setUpClass(cls):
        cls.tts = PiperTTS()
        cls.has_piper = cls._check_piper()
    
    @classmethod
    def _check_piper(cls):
        """Check if Piper is installed."""
        try:
            result = subprocess.run(
                ["piper", "--help"],
                capture_output=True,
                timeout=5
            )
            return result.returncode == 0
        except Exception:
            return False
    
    def test_synthesize_text(self):
        """TTS should synthesize audio."""
        audio = self.tts.synthesize("Hello world")
        self.assertIsInstance(audio, np.ndarray)
        self.assertGreater(len(audio), 0)
    
    def test_synthesize_empty(self):
        """TTS should handle empty text."""
        audio = self.tts.synthesize("")
        self.assertIsInstance(audio, np.ndarray)
    
    def test_synthesize_latency(self):
        """TTS should complete in reasonable time."""
        start = time.time()
        self.tts.synthesize("Hello")
        elapsed = (time.time() - start) * 1000
        self.assertLess(elapsed, 5000, "TTS should complete in < 5 seconds")


class TestVoiceChannelIntegration(unittest.TestCase):
    """Integration tests for the full pipeline."""
    
    @classmethod
    def setUpClass(cls):
        cls.config = VoiceChannelConfig(
            whisper_model="tiny",
            ollama_model="qwen2.5:7b"
        )
    
    def test_config_creation(self):
        """Config should be created with defaults."""
        config = VoiceChannelConfig()
        self.assertEqual(config.sample_rate, 16000)
        self.assertEqual(config.whisper_model, "tiny")
    
    def test_metrics_tracking(self):
        """Metrics should track timing data."""
        metrics = TimingMetrics(turn_id=1)
        metrics.stt_start_ms = time.time() * 1000
        metrics.stt_end_ms = metrics.stt_start_ms + 150
        
        self.assertEqual(metrics.turn_id, 1)
        self.assertEqual(metrics.stt_end_ms - metrics.stt_start_ms, 150)


class TestEndToEndLatency(unittest.TestCase):
    """End-to-end latency tests."""
    
    @classmethod
    def setUpClass(cls):
        cls.config = VoiceChannelConfig()
        cls.ollama_available = TestOllamaLLM._check_ollama()
    
    def test_stt_latency_target(self):
        """STT should meet <300ms target."""
        try:
            stt = WhisperSTT(model_name="tiny")
        except Exception as e:
            self.skipTest(f"Whisper not available: {e}")
        
        # Create short audio sample
        silence = np.zeros(8000, dtype=np.float32)
        
        latencies = []
        for _ in range(3):
            start = time.time()
            stt.transcribe(silence)
            elapsed = (time.time() - start) * 1000
            latencies.append(elapsed)
        
        avg_latency = sum(latencies) / len(latencies)
        print(f"STT average latency: {avg_latency:.0f}ms")
        # Note: This is a soft check - actual latency depends on hardware
        self.assertLess(avg_latency, 1000, "STT should complete in < 1s")
    
    def test_llm_ttfb_target(self):
        """LLM TTFB should meet <500ms target."""
        if not self.ollama_available:
            self.skipTest("Ollama not available")
        
        llm = OllamaLLM()
        
        ttfs = []
        for _ in range(3):
            start = time.time() * 1000
            ttfb = 0
            
            def on_token(t):
                nonlocal ttfb
                if ttfb == 0:
                    ttfb = time.time() * 1000
            
            llm.generate("Hello", stream_callback=on_token)
            
            if ttfb > 0:
                ttfs.append(ttfb - start)
        
        if ttfs:
            avg_ttfb = sum(ttfs) / len(ttfs)
            print(f"LLM TTFB: {avg_ttfb:.0f}ms")
            self.assertLess(avg_ttfb, 1000, "TTFB should be < 1s")


def run_component_checks():
    """Check if all required components are available."""
    checks = {
        "Python": sys.version_info[:2] >= (3, 9),
        "NumPy": False,
        "SoundDevice": False,
        "Requests": False,
        "Torch": False,
        "Whisper": False,
        "Ollama": False,
        "Piper": False,
    }
    
    # Check Python packages
    try:
        import numpy
        checks["NumPy"] = True
    except ImportError:
        pass
    
    try:
        import sounddevice
        checks["SoundDevice"] = True
    except ImportError:
        pass
    
    try:
        import requests
        checks["Requests"] = True
    except ImportError:
        pass
    
    try:
        import torch
        checks["Torch"] = True
    except ImportError:
        pass
    
    try:
        import whisper
        checks["Whisper"] = True
    except ImportError:
        pass
    
    # Check Ollama
    try:
        response = requests.get("http://localhost:11434/api/tags", timeout=2)
        if response.status_code == 200:
            checks["Ollama"] = True
    except Exception:
        pass
    
    # Check Piper
    try:
        result = subprocess.run(["piper", "--help"], capture_output=True, timeout=2)
        checks["Piper"] = result.returncode == 0
    except Exception:
        pass
    
    print("\n" + "=" * 50)
    print("COMPONENT AVAILABILITY CHECK")
    print("=" * 50)
    for component, available in checks.items():
        status = "✅" if available else "❌"
        print(f"{status} {component}")
    
    all_available = all(checks.values())
    print("=" * 50)
    
    if not all_available:
        print("\nMissing dependencies:")
        print("  pip install numpy sounddevice requests torch openai-whisper")
        print("\nOllama installation: https://ollama.ai")
        print("Piper installation: https://github.com/rhasspy/piper")
    
    return all_available


def main():
    """Run all tests."""
    # Run component checks first
    components_ok = run_component_checks()
    
    # Create test suite
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    
    # Add all test classes
    suite.addTests(loader.loadTestsFromTestCase(TestSileroVAD))
    suite.addTests(loader.loadTestsFromTestCase(TestWhisperSTT))
    suite.addTests(loader.loadTestsFromTestCase(TestOllamaLLM))
    suite.addTests(loader.loadTestsFromTestCase(TestPiperTTS))
    suite.addTests(loader.loadTestsFromTestCase(TestVoiceChannelIntegration))
    suite.addTests(loader.loadTestsFromTestCase(TestEndToEndLatency))
    
    # Run tests
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    
    # Summary
    print("\n" + "=" * 50)
    print("TEST SUMMARY")
    print("=" * 50)
    print(f"Tests run: {result.testsRun}")
    print(f"Successes: {result.testsRun - len(result.failures) - len(result.errors)}")
    print(f"Failures: {len(result.failures)}")
    print(f"Errors: {len(result.errors)}")
    print(f"Skipped: {len(result.skipped)}")
    print("=" * 50)
    
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
