"""The driver and core conformance suites against the in-memory broker, in its default shape and in the shapes that
mimic other brokers (no headers → structured mode; native replies; no undeliverable reports; a small message limit)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk.transport import BrokerConfig, MemoryBroker  # noqa: E402
from landflow_sdk.transport.conformance import ConformanceTarget, CoreConformance, DriverConformance  # noqa: E402

try:
    import cryptography  # noqa: F401

    HAVE_CRYPTO = True
except ImportError:  # pragma: no cover
    HAVE_CRYPTO = False


def target(name: str, **overrides) -> ConformanceTarget:
    broker = MemoryBroker(**overrides)
    return ConformanceTarget(name, broker.driver, BrokerConfig("mem"), delivery_timeout_s=3)


class MemoryDriverConformance(DriverConformance, unittest.TestCase):
    target = target("memory")


class MemoryStructuredDriverConformance(DriverConformance, unittest.TestCase):
    target = target("memory-structured", headers=False)


class MemoryNativeDriverConformance(DriverConformance, unittest.TestCase):
    target = target("memory-native", replies="native")


class MemoryInferredDriverConformance(DriverConformance, unittest.TestCase):
    target = target("memory-inferred", undeliverable="inferred")


@unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
class MemoryCoreConformance(CoreConformance, unittest.TestCase):
    target = target("memory")


@unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
class MemoryStructuredCoreConformance(CoreConformance, unittest.TestCase):
    target = target("memory-structured", headers=False)


@unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
class MemoryNativeCoreConformance(CoreConformance, unittest.TestCase):
    target = target("memory-native", replies="native")


@unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
class MemoryInferredCoreConformance(CoreConformance, unittest.TestCase):
    target = target("memory-inferred", undeliverable="inferred")


@unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
class MemorySmallCoreConformance(CoreConformance, unittest.TestCase):
    target = target("memory-small", max_message_bytes=16 * 1024)


if __name__ == "__main__":
    unittest.main()
