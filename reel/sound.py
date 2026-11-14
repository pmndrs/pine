# The reel's sound: the keys and the mouse, made here. A cue with `f` plays a recording instead
# (a clip's own sound, as it was filmed), faded in and out so that it does not click.
#
# A key is plastic hitting plastic: a burst of noise that is over in a few milliseconds. So every
# sound here is shaped noise and nothing else: a bright tick, a duller body under it, a short
# thud where the key lands. There is no tone in any of them. A tone, however short, gives a key
# a pitch, and a row of pitched keys sounds like anything but typing. The noise is coloured
# first and cut to its short shape afterwards, so that nothing sounds before the key is hit.
# All of it is quiet: this is somebody typing in the room, not the subject of the film.
#
#   python3 sound.py cues.json out.wav
import json, sys, wave
import numpy as np

SR = 48000
rng = np.random.default_rng(11)

def noise(n, hz, octaves):
    """Noise around one frequency, `octaves` wide, of a steady loudness."""
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.maximum(np.fft.rfftfreq(n, 1 / SR), 1)
    spec *= np.exp(-0.5 * (np.log2(f / hz) / (octaves / 2)) ** 2)
    x = np.fft.irfft(spec, n)
    return x / np.sqrt((x ** 2).mean())

def hit(n, hz, octaves, tau, attack=0.00025):
    """One short burst: there at once, gone within a few times `tau` seconds."""
    t = np.arange(n) / SR
    return noise(n, hz, octaves) * np.minimum(t / attack, 1) * np.exp(-t / tau)

def press(n, tick=1.0, body=0.5, thud=0.2, bright=1.0):
    j = lambda: rng.uniform(0.88, 1.12)
    return (tick * hit(n, 4200 * bright * j(), 1.8, 0.0017 * j())
            + body * hit(n, 1150 * bright * j(), 1.4, 0.0038 * j())
            + thud * hit(n, 340 * j(), 1.1, 0.0065 * j()))

def at(x, seconds, y):
    i = int(seconds * SR)
    x[i:i + len(y)] += y[: len(x) - i]

def key(wide=False, big=False):
    """A key going down and, a moment later and much quieter, coming back up."""
    n = int(0.16 * SR)
    x = np.zeros(n)
    at(x, 0, press(int(0.05 * SR), body=0.75 if wide or big else 0.5, thud=0.42 if wide or big else 0.2, bright=0.88 if wide or big else 1.0))
    at(x, rng.uniform(0.085, 0.105) if big else rng.uniform(0.06, 0.09), 0.3 * press(int(0.03 * SR), body=0.2, thud=0.0, bright=1.2))
    return x

def mouse(down=True, up=True):
    """A switch snapping: sharper and thinner than a key, once down and once up."""
    n = int(0.14 * SR)
    x = np.zeros(n)
    snap = lambda bright: hit(int(0.03 * SR), 3600 * bright, 1.5, 0.0011) + 0.5 * hit(int(0.03 * SR), 1900 * bright, 1.2, 0.0024)
    if down:
        at(x, 0, snap(1.0))
    if up:
        at(x, 0.075 if down else 0, 0.6 * snap(1.2))
    return x

def tap():
    """A finger on glass: hardly there."""
    return hit(int(0.04 * SR), 1700 * rng.uniform(0.9, 1.1), 1.3, 0.0028) + 0.3 * hit(int(0.04 * SR), 3400, 1.4, 0.0012)

# A handful of each, as a keyboard has a handful of keys that sound alike but not the same.
# `peak` is how loud one is at its loudest, where 1 is as loud as a file can be.
def pool(make, count, peak):
    out = []
    for _ in range(count):
        x = make()
        out.append(x * peak / np.abs(x).max())
    return out

POOL = {
    "key": pool(key, 28, 0.1),
    "key-space": pool(lambda: key(wide=True), 6, 0.11),
    "enter": pool(lambda: key(big=True), 4, 0.12),
    "click": pool(mouse, 5, 0.13),
    "release": pool(lambda: mouse(down=False), 4, 0.1),
    "tap": pool(tap, 10, 0.03),
    "tap-space": pool(tap, 4, 0.03),
}

def describe(name):
    """What a sound is like, in numbers, for whoever cannot listen: where its weight lies, how long it lasts, how much of a tone it has."""
    x = POOL[name][0]
    spec = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / SR)
    centre = (f * spec).sum() / spec.sum()
    low = spec[f < 250].sum() / spec.sum()
    # 1 is pure noise, towards 0 is a tone. Taken where the sound has its weight.
    band = spec[(f > 300) & (f < 9000)]
    flat = np.exp(np.log(band + 1e-20).mean()) / band.mean()
    loud = np.abs(x)
    last = np.nonzero(loud > loud.max() * 0.03)[0]
    first = int(last[0])
    main = np.nonzero(loud[: first + int(0.05 * SR)] > loud.max() * 0.03)[0]
    return f"{name:10} peak {loud.max():.3f}  centre {centre:5.0f} Hz  below 250 Hz {low * 100:4.1f}%  noise-likeness {flat:.2f}  the hit lasts {(main[-1] - first) / SR * 1000:4.1f} ms"

if __name__ == "__main__":
    cues = json.load(open(sys.argv[1]))
    out = np.zeros((int((cues["duration"] + 1) * SR), 2))
    import os
    for c in cues["cues"]:
        if c.get("f"):
            with wave.open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), c["f"])) as w:
                y = np.frombuffer(w.readframes(w.getnframes()), "<i2").reshape(-1, w.getnchannels()).astype(float) / 32768
            if y.shape[1] == 1: y = np.repeat(y, 2, 1)
            fade = np.minimum(1, np.minimum(np.arange(len(y)), np.arange(len(y))[::-1]) / (0.25 * SR))[:, None]
            start = int(c["t"] * SR); end = min(len(out), start + len(y))
            out[start:end] += (y * fade * c.get("gain", 1.0))[: end - start]
            continue
        k = c["k"] if c["k"] in POOL else c["k"].split("-")[0]
        x = POOL[k][rng.integers(len(POOL[k]))] * rng.uniform(0.7, 1.0)
        start = int(c["t"] * SR)
        pan = rng.uniform(-0.15, 0.15) if k.startswith(("key", "tap", "enter")) else 0.0
        end = min(len(out), start + len(x))
        out[start:end, 0] += x[: end - start] * (1 - pan)
        out[start:end, 1] += x[: end - start] * (1 + pan)
    with wave.open(sys.argv[2], "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(out, -1, 1) * 32767).astype("<i2").tobytes())
    for name in POOL:
        print(describe(name))
    gaps = np.diff(sorted(c["t"] for c in cues["cues"] if c["k"].startswith("key")))
    typing = gaps[gaps < 0.4]
    print(f"sound: {len(cues['cues'])} cues, peak {np.abs(out).max():.2f}, rms {np.sqrt((out ** 2).mean()):.4f}, keys {1 / typing.mean():.1f} a second while typing (fastest two {typing.min() * 1000:.0f} ms apart)")
