# Greenhouse — Hardware / Wiring Recommendations

## Soil moisture sensors (VH400)

These are improvements to the soil moisture sensor wiring that should reduce
cross-channel interference (the "drop on plant 4 activation" symptom).

## Star ground (most important)

Currently the four VH400 sensors share a common GND bar — every sensor's return
current flows through every link of the chain. When one sensor draws current,
its return path adds a small voltage drop to every other sensor's reference,
which the ADC then reads as a moisture change.

**Fix:** run a separate GND wire from each VH400 directly to a single point —
either the GND terminal on the PSU or a single screw terminal that is itself
wired straight to the PSU's GND. None of these wires should pass through any
other sensor's GND on the way.

```
PSU GND ─┬── (short, thick) ── star point
          │
          ├──── wire 1 ──── VH400 #1 GND
          ├──── wire 2 ──── VH400 #2 GND
          ├──── wire 3 ──── VH400 #3 GND
          ├──── wire 4 ──── VH400 #4 GND
          └──── wire to ESP32 GND
```

The ESP32 GND must reach the same star point — otherwise the ADC's reference
sits at a different ground potential than the sensors.

## Star power (or a heavy common bus)

Same logic for the +5 V rail. Either:

- **Star wiring** — separate +V wire from PSU to each sensor; or
- **Heavy common bus** — if you keep a shared rail, use thick wire (≥18 AWG /
  0.75 mm²) and short runs so the voltage drop with all four sensors active
  (~28 mA) stays under ~10 mV.

Don't daisy-chain a thin wire from sensor to sensor; that's the worst case.

## Decoupling capacitors at each sensor (cheap, high-value)

Solder a **100 nF ceramic + 10 µF electrolytic** in parallel from V+ to GND
*right at each VH400* (within ~1 cm of the sensor's terminals). The 100 nF
shunts high-frequency noise; the 10 µF holds the local rail steady against
transient current pulses from neighbouring sensors.

```
   V+  ──┬──────── to sensor V+
         │
         ┴ 100 nF (ceramic)
         ┬
         │
         ┴ 10 µF (electrolytic — observe polarity)
         ┬
         │
   GND ──┴──────── to sensor GND
```

These two caps cost a few pence and solve a lot of "weird ADC noise" issues.

## Twisted pair the signal back

For each sensor, the signal wire and a dedicated GND return wire should travel
back to the ESP32 as a twisted pair. Magnetically-induced noise scales with the
loop area enclosed by signal and return; twisting collapses the loop area to
nearly zero.

Same idea is used in CAT-5 cabling — every signal pair has its own return
twisted around it.

## Keep low-current and high-current wiring apart

Solenoid valves and the pump are inductive loads — switching them produces
sharp voltage transients that couple capacitively into nearby low-current
signal lines. Keep at least a few centimetres of physical separation between:

- The +5 V sensor wiring
- The relay/pump 12 V (or whatever) wiring

If they have to cross, do it at right angles rather than parallel.

## Optional: switched sensor power

If you ever want to add per-sensor power switching (so each VH400 is only
powered while it's being read), the firmware already has a place for it: add
a `soil_power_pin` field to `PlantConfig` and corresponding GPIOs (e.g.
D7-D10), and toggle them in `readSoilMoisture` around the analog read. The
VH400 takes ~30 ms to settle after power-on, so wait at least 50 ms before
sampling. Each VH400 draws ~7 mA, well within the ESP32-S3's ~40 mA per-pin
limit, so direct GPIO drive is fine — no MOSFET needed.

This was investigated and reverted because the current wiring puts sensor V+
on a common bar straight from the PSU, which would need rewiring before
GPIO-based switching could work.

---

## Water level sensor (optical IR)

Three-wire optical IR liquid level sensor (e.g. the Marinecolor one on Amazon).
These are NPN open-collector devices — the signal line is pulled to GND when
triggered and floats otherwise.

### Wiring

| Sensor wire | Connect to | Notes |
|---|---|---|
| Red (V+) | 5 V from PSU | Same rail as the VH400s |
| Black / Blue (GND) | Common ground | Star-ground point |
| Yellow / White (Sig) | ESP32 digital pin (e.g. D11) | With INPUT_PULLUP |

### Use a digital pin, not analog

The sensor is digital on/off. The current `WATER1_LEVEL_SENSOR A6` definition
in `config.h` treats it as analog and won't work properly. Move it to D11 (or
any free digital pin: D11, D12, D13).

### Why INPUT_PULLUP

The NPN open-collector output can only pull the signal **down to GND**. When
inactive, the wire is floating and the ESP32 will read random noise. Either:

1. **Internal pull-up** (easiest): `pinMode(D11, INPUT_PULLUP)` — the MCU holds
   the line at 3.3 V when the sensor is inactive
2. **External 10 kΩ resistor** between the signal wire and **3.3 V** — *do not
   pull up to 5 V*; that would feed 5 V into a 3.3 V GPIO and damage it

### Determining "water present" polarity

Sensors come in normally-open and normally-closed variants and the listing
isn't always specific.

To find out: wire it up, check the signal voltage with a multimeter while
dunking the prism in a glass of water:

1. Sensor in air → signal should read ~3.3 V (with internal pull-up enabled)
2. Sensor submerged → signal should drop to ~0 V (or vice-versa)

Note which state means "submerged" so the firmware logic matches.

### If it doesn't switch states

Common causes:
- Wrong wire colours — these aren't 100 % standard; check the listing
- Sensor needs more than 5 V — some variants are 5-24 V, but they still output
  a 5 V signal which would damage a 3.3 V GPIO; check the listing carefully
  before wiring direct, or use a level shifter / voltage divider
- Some sensors have a sensitivity potentiometer that needs adjusting

### Firmware to add (once wired)

- Read on each loop with `digitalRead()`
- Refuse to start watering when the tank is empty
- Expose state to the server, OLED, and web UI
