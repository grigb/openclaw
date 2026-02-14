#!/usr/bin/env python3
"""
Voice Channel MVP - Performance Benchmark
Measures latency for each component and end-to-end pipeline.
"""

import json
import statistics
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List, Dict

import numpy as np
import requests

# Add the voice channel module to path
sys.path.insert(0, str(Path(__file__).parent))

from voice_channel_mvp import (
    VoiceChannelConfig,
    SileroVAD,
    WhisperSTT,
    OllamaLLM,
    PiperTTS
)


@dataclass
class BenchmarkResult:
    """Results from a benchmark run."""
    component: str
    metric: str
    samples: int
    min_ms: float
    max_ms: float
    mean_ms: float
    median_ms: float
    std_ms: float
    p95_ms: float
    p99_ms: float
    target_ms: float
    pass_rate: float
    
    def to_dict(self) -> Dict:
        return asdict(self)
    
    def __str__(self) -> str:
        status = "✅ PASS" if self.pass_rate >= 0.8 else "⚠️ MARGINAL" if self.pass_rate >= 0.5 else "❌ FAIL"
        return (
            f"{status} {self.component} - {self.metric}\n"
            f"    Samples: {self.samples} | Mean: {self.mean_ms:.1f}ms | Median: {self.median_ms:.1f}ms\n"
            f"    Min: {self.min_ms:.1f}ms | Max: {self.max_ms:.1f}ms | Std: {self.std_ms:.1f}ms\n"
            f"    P95: {self.p95_ms:.1f}ms | P99: {self.p99_ms:.1f}ms | Target: {self.target_ms}ms\n"
            f"    Pass rate: {self.pass_rate*100:.1f}% (latencies under target)"
        )


class PerformanceBenchmark:
    """Benchmark suite for voice channel components."""
    
    def __init__(self, config: VoiceChannelConfig = None):
        self.config = config or VoiceChannelConfig()
        self.results: List[BenchmarkResult] = []
        
    def run_all(self, samples: int = 10) -> List[BenchmarkResult]:
        """Run all benchmarks."""
        print("=" * 70)
        print("VOICE CHANNEL PERFORMANCE BENCHMARK")
        print("=" * 70)
        print(f"Configuration:")
        print(f"  Sample rate: {self.config.sample_rate} Hz")
        print(f"  Whisper model: {self.config.whisper_model}")
        print(f"  Ollama model: {self.config.ollama_model}")
        print(f"  Piper model: {self.config.piper_model}")
        print(f"  Benchmark samples per test: {samples}")
        print("=" * 70)
        print()
        
        # Check component availability
        self._check_components()
        
        # Run benchmarks
        self.benchmark_vad()
        self.benchmark_stt(samples)
        self.benchmark_llm_ttfb(samples)
        self.benchmark_llm_total(samples)
        self.benchmark_tts(samples)
        self.benchmark_e2e(samples)
        
        return self.results
    
    def _check_components(self):
        """Check which components are available."""
        print("Checking component availability...")
        
        checks = {}
        
        # Check Whisper
        try:
            import whisper
            checks["Whisper"] = True
        except ImportError:
            checks["Whisper"] = False
        
        # Check Ollama
        try:
            response = requests.get("http://localhost:11434/api/tags", timeout=2)
            checks["Ollama"] = response.status_code == 200
        except Exception:
            checks["Ollama"] = False
        
        # Check Piper
        try:
            import subprocess
            result = subprocess.run(["piper", "--help"], capture_output=True, timeout=2)
            checks["Piper"] = result.returncode == 0
        except Exception:
            checks["Piper"] = False
        
        # Check PyTorch (for VAD)
        try:
            import torch
            checks["PyTorch/VAD"] = True
        except ImportError:
            checks["PyTorch/VAD"] = False
        
        print("Component status:")
        for name, available in checks.items():
            status = "✅ Available" if available else "❌ Not available"
            print(f"  {status}: {name}")
        print()
        
        self.components_available = checks
    
    def _calculate_stats(self, latencies: List[float], target_ms: float, component: str, metric: str) -> BenchmarkResult:
        """Calculate statistics from latency samples."""
        if not latencies:
            return BenchmarkResult(
                component=component,
                metric=metric,
                samples=0,
                min_ms=0,
                max_ms=0,
                mean_ms=0,
                median_ms=0,
                std_ms=0,
                p95_ms=0,
                p99_ms=0,
                target_ms=target_ms,
                pass_rate=0
            )
        
        sorted_latencies = sorted(latencies)
        n = len(sorted_latencies)
        
        under_target = sum(1 for l in latencies if l < target_ms)
        pass_rate = under_target / n if n > 0 else 0
        
        return BenchmarkResult(
            component=component,
            metric=metric,
            samples=n,
            min_ms=min(sorted_latencies),
            max_ms=max(sorted_latencies),
            mean_ms=statistics.mean(sorted_latencies),
            median_ms=statistics.median(sorted_latencies),
            std_ms=statistics.stdev(sorted_latencies) if n > 1 else 0,
            p95_ms=sorted_latencies[int(n * 0.95)] if n > 1 else sorted_latencies[0],
            p99_ms=sorted_latencies[int(n * 0.99)] if n > 1 else sorted_latencies[0],
            target_ms=target_ms,
            pass_rate=pass_rate
        )
    
    def benchmark_vad(self):
        """Benchmark Voice Activity Detection."""
        print("Benchmarking VAD...")
        
        try:
            vad = SileroVAD(sample_rate=self.config.sample_rate)
        except Exception as e:
            print(f"  ❌ VAD initialization failed: {e}")
            return
        
        # Generate test audio
        test_audio = np.random.randn(480).astype(np.float32) * 0.1
        
        latencies = []
        for _ in range(100):
            start = time.time()
            vad.is_speech(test_audio)
            elapsed = (time.time() - start) * 1000
            latencies.append(elapsed)
        
        result = self._calculate_stats(latencies, 10, "Silero VAD", "inference")
        self.results.append(result)
        print(f"  {result}\n")
    
    def benchmark_stt(self, samples: int = 10):
        """Benchmark Speech-to-Text."""
        print("Benchmarking STT (Whisper)...")
        
        if not self.components_available.get("Whisper"):
            print("  ⚠️ Whisper not available, skipping\n")
            return
        
        try:
            stt = WhisperSTT(
                model_name=self.config.whisper_model,
                language=self.config.whisper_language
            )
        except Exception as e:
            print(f"  ❌ STT initialization failed: {e}\n")
            return
        
        # Generate 2-second audio
        test_audio = np.zeros(int(self.config.sample_rate * 2), dtype=np.float32)
        
        latencies = []
        for i in range(samples):
            print(f"  Sample {i+1}/{samples}...", end="\r")
            start = time.time()
            stt.transcribe(test_audio, self.config.sample_rate)
            elapsed = (time.time() - start) * 1000
            latencies.append(elapsed)
        
        print(f"  Sample {samples}/{samples}... Done")
        
        result = self._calculate_stats(latencies, 300, "Whisper STT", "transcription")
        self.results.append(result)
        print(f"  {result}\n")
    
    def benchmark_llm_ttfb(self, samples: int = 10):
        """Benchmark LLM Time to First Byte."""
        print("Benchmarking LLM TTFB...")
        
        if not self.components_available.get("Ollama"):
            print("  ⚠️ Ollama not available, skipping\n")
            return
        
        try:
            llm = OllamaLLM(
                base_url=self.config.ollama_url,
                model=self.config.ollama_model
            )
        except Exception as e:
            print(f"  ❌ LLM initialization failed: {e}\n")
            return
        
        latencies = []
        for i in range(samples):
            print(f"  Sample {i+1}/{samples}...", end="\r")
            
            start = time.time() * 1000
            ttfb = 0
            
            def on_token(token):
                nonlocal ttfb
                if ttfb == 0:
                    ttfb = time.time() * 1000
            
            llm.generate("Say hello in exactly one word.", stream_callback=on_token)
            
            if ttfb > 0:
                latencies.append(ttfb - start)
        
        print(f"  Sample {samples}/{samples}... Done")
        
        result = self._calculate_stats(latencies, 500, "Ollama LLM", "TTFB")
        self.results.append(result)
        print(f"  {result}\n")
    
    def benchmark_llm_total(self, samples: int = 10):
        """Benchmark total LLM generation time."""
        print("Benchmarking LLM total generation...")
        
        if not self.components_available.get("Ollama"):
            print("  ⚠️ Ollama not available, skipping\n")
            return
        
        try:
            llm = OllamaLLM(
                base_url=self.config.ollama_url,
                model=self.config.ollama_model
            )
        except Exception as e:
            print(f"  ❌ LLM initialization failed: {e}\n")
            return
        
        latencies = []
        for i in range(samples):
            print(f"  Sample {i+1}/{samples}...", end="\r")
            
            start = time.time()
            llm.generate("Say hello in exactly one word.")
            elapsed = (time.time() - start) * 1000
            latencies.append(elapsed)
        
        print(f"  Sample {samples}/{samples}... Done")
        
        result = self._calculate_stats(latencies, 2000, "Ollama LLM", "total generation")
        self.results.append(result)
        print(f"  {result}\n")
    
    def benchmark_tts(self, samples: int = 10):
        """Benchmark Text-to-Speech."""
        print("Benchmarking TTS (Piper)...")
        
        try:
            tts = PiperTTS(
                model_name=self.config.piper_model,
                model_path=self.config.piper_model_path
            )
        except Exception as e:
            print(f"  ❌ TTS initialization failed: {e}\n")
            return
        
        test_text = "Hello, this is a test of the voice channel system."
        
        latencies = []
        for i in range(samples):
            print(f"  Sample {i+1}/{samples}...", end="\r")
            start = time.time()
            tts.synthesize(test_text)
            elapsed = (time.time() - start) * 1000
            latencies.append(elapsed)
        
        print(f"  Sample {samples}/{samples}... Done")
        
        result = self._calculate_stats(latencies, 200, "Piper TTS", "synthesis")
        self.results.append(result)
        print(f"  {result}\n")
    
    def benchmark_e2e(self, samples: int = 5):
        """Benchmark end-to-end pipeline."""
        print("Benchmarking end-to-end pipeline...")
        
        # Check all components
        if not all([
            self.components_available.get("Whisper"),
            self.components_available.get("Ollama")
        ]):
            print("  ⚠️ Required components not available, skipping\n")
            return
        
        try:
            stt = WhisperSTT(
                model_name=self.config.whisper_model,
                language=self.config.whisper_language
            )
            llm = OllamaLLM(
                base_url=self.config.ollama_url,
                model=self.config.ollama_model
            )
            tts = PiperTTS(
                model_name=self.config.piper_model,
                model_path=self.config.piper_model_path
            )
        except Exception as e:
            print(f"  ❌ Component initialization failed: {e}\n")
            return
        
        # Generate test audio
        test_audio = np.zeros(int(self.config.sample_rate * 1), dtype=np.float32)
        
        latencies = []
        for i in range(samples):
            print(f"  Sample {i+1}/{samples}...", end="\r")
            
            start = time.time()
            
            # STT
            text = stt.transcribe(test_audio)
            
            # LLM
            response = llm.generate(text or "Hello")
            
            # TTS
            tts.synthesize(response)
            
            elapsed = (time.time() - start) * 1000
            latencies.append(elapsed)
        
        print(f"  Sample {samples}/{samples}... Done")
        
        result = self._calculate_stats(latencies, 1000, "End-to-End Pipeline", "total latency")
        self.results.append(result)
        print(f"  {result}\n")
    
    def print_summary(self):
        """Print summary of all benchmarks."""
        print("=" * 70)
        print("BENCHMARK SUMMARY")
        print("=" * 70)
        
        total = len(self.results)
        passed = sum(1 for r in self.results if r.pass_rate >= 0.8)
        marginal = sum(1 for r in self.results if 0.5 <= r.pass_rate < 0.8)
        failed = sum(1 for r in self.results if r.pass_rate < 0.5)
        
        print(f"Total benchmarks: {total}")
        print(f"  ✅ Passed: {passed}")
        print(f"  ⚠️ Marginal: {marginal}")
        print(f"  ❌ Failed: {failed}")
        
        print("\nDetailed Results:")
        for result in self.results:
            status = "✅" if result.pass_rate >= 0.8 else "⚠️" if result.pass_rate >= 0.5 else "❌"
            print(f"  {status} {result.component:20} {result.metric:20} Mean: {result.mean_ms:6.1f}ms (target: {result.target_ms}ms)")
        
        print("=" * 70)
    
    def save_results(self, filename: str = None):
        """Save results to JSON file."""
        if filename is None:
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            filename = f"benchmark_results_{timestamp}.json"
        
        filepath = Path(filename)
        
        data = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "config": {
                "sample_rate": self.config.sample_rate,
                "whisper_model": self.config.whisper_model,
                "ollama_model": self.config.ollama_model,
                "piper_model": self.config.piper_model,
            },
            "results": [r.to_dict() for r in self.results]
        }
        
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)
        
        print(f"\nResults saved to: {filepath}")


def main():
    """Main entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Voice Channel Performance Benchmark")
    parser.add_argument("--samples", type=int, default=10, help="Number of samples per test")
    parser.add_argument("--whisper-model", default="tiny", help="Whisper model size")
    parser.add_argument("--ollama-model", default="qwen2.5:7b", help="Ollama model name")
    parser.add_argument("--output", help="Output JSON file for results")
    parser.add_argument("--save", action="store_true", help="Save results to file")
    
    args = parser.parse_args()
    
    config = VoiceChannelConfig(
        whisper_model=args.whisper_model,
        ollama_model=args.ollama_model
    )
    
    benchmark = PerformanceBenchmark(config)
    benchmark.run_all(samples=args.samples)
    benchmark.print_summary()
    
    if args.save or args.output:
        benchmark.save_results(args.output)
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
