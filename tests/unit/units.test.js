'use strict';

const {
  fahrenheitToCelsius,
  isPlausibleTemperatureC,
  normalizeUnitRatio,
  normalizeSignalQuality,
  isPlausibleVibrationG,
} = require('../../src/modules/normalization/units');

describe('unit handling', () => {
  test('converts Fahrenheit to Celsius deterministically', () => {
    expect(fahrenheitToCelsius(181.2)).toBe(82.889);
    expect(fahrenheitToCelsius(206.6)).toBe(97.0);
    expect(fahrenheitToCelsius(32)).toBe(0);
    expect(fahrenheitToCelsius(212)).toBe(100);
  });

  test('rejects non-numeric Fahrenheit', () => {
    expect(fahrenheitToCelsius('warm')).toBeNull();
    expect(fahrenheitToCelsius(null)).toBeNull();
  });

  test('plausibility rejects the -999 sentinel', () => {
    expect(isPlausibleTemperatureC(-999)).toBe(false);
    expect(isPlausibleTemperatureC(97)).toBe(true);
    expect(isPlausibleTemperatureC(5000)).toBe(false);
  });

  test('vibration_g plausibility', () => {
    expect(isPlausibleVibrationG(0.81)).toBe(true);
    expect(isPlausibleVibrationG(-1)).toBe(false);
    expect(isPlausibleVibrationG(9999)).toBe(false);
  });

  test('[0,1] ratio normalization', () => {
    expect(normalizeUnitRatio(0.87)).toBe(0.87);
    expect(normalizeUnitRatio(1.2)).toBeNull();
    expect(normalizeUnitRatio(-0.1)).toBeNull();
    expect(normalizeUnitRatio('')).toBeNull();
    expect(normalizeUnitRatio(null)).toBeNull();
  });

  test('signal quality is normalized to canonical tokens or null', () => {
    expect(normalizeSignalQuality('good')).toBe('GOOD');
    expect(normalizeSignalQuality(' FAIR ')).toBe('FAIR');
    expect(normalizeSignalQuality('excellent')).toBeNull();
    expect(normalizeSignalQuality(null)).toBeNull();
  });
});
