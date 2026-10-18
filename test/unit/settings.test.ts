import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  clampMaxFileSizeMB,
  defaultDeviceName,
} from '../../src/settings';

describe('settings', () => {
  describe('defaultDeviceName', () => {
    it('returns iPhone for iOS phone', () => {
      expect(
        defaultDeviceName({
          isIosApp: true,
          isAndroidApp: false,
          isTablet: false,
        }),
      ).toBe('iPhone');
    });

    it('returns iPad for iOS tablet', () => {
      expect(
        defaultDeviceName({
          isIosApp: true,
          isAndroidApp: false,
          isTablet: true,
        }),
      ).toBe('iPad');
    });

    it('returns Android for Android app', () => {
      expect(
        defaultDeviceName({
          isIosApp: false,
          isAndroidApp: true,
          isTablet: false,
        }),
      ).toBe('Android');
      expect(
        defaultDeviceName({
          isIosApp: false,
          isAndroidApp: true,
          isTablet: true,
        }),
      ).toBe('Android');
    });

    it('returns Desktop for desktop platforms', () => {
      expect(
        defaultDeviceName({
          isIosApp: false,
          isAndroidApp: false,
          isTablet: false,
        }),
      ).toBe('Desktop');
    });
  });

  describe('clampMaxFileSizeMB', () => {
    it('clamps values higher than 150 to 150', () => {
      expect(clampMaxFileSizeMB(500)).toBe(150);
    });

    it('clamps values lower than 1 to 1', () => {
      expect(clampMaxFileSizeMB(0)).toBe(1);
      expect(clampMaxFileSizeMB(-10)).toBe(1);
    });

    it('keeps values in range 1..150', () => {
      expect(clampMaxFileSizeMB(50)).toBe(50);
      expect(clampMaxFileSizeMB(1)).toBe(1);
      expect(clampMaxFileSizeMB(150)).toBe(150);
    });
  });

  describe('DEFAULT_SETTINGS', () => {
    it('has expected default values', () => {
      expect(DEFAULT_SETTINGS.triggers.editDebounceSec).toBe(10);
      expect(DEFAULT_SETTINGS.triggers.intervalMin).toBe(5);
      expect(DEFAULT_SETTINGS.triggers.onStartup).toBe(true);
      expect(DEFAULT_SETTINGS.triggers.onResume).toBe(true);
      expect(DEFAULT_SETTINGS.triggers.onEdit).toBe(true);
      expect(DEFAULT_SETTINGS.triggers.interval).toBe(true);
      expect(DEFAULT_SETTINGS.triggers.longpoll).toBe(true);

      expect(DEFAULT_SETTINGS.maxFileSizeMB).toBe(50);
      expect(DEFAULT_SETTINGS.baseSizeCapMB).toBe(1);
      expect(DEFAULT_SETTINGS.guard).toEqual({
        maxDeletes: 10,
        maxPercent: 10,
      });

      expect(DEFAULT_SETTINGS.configSync.core).toBe(false);
      expect(DEFAULT_SETTINGS.configSync.themes).toBe(false);
      expect(DEFAULT_SETTINGS.configSync.plugins).toBe(false);
      expect(DEFAULT_SETTINGS.configSync.workspace).toBe(false);

      expect(DEFAULT_SETTINGS.refreshToken).toBeNull();
      expect(DEFAULT_SETTINGS.accountEmail).toBeNull();
      expect(DEFAULT_SETTINGS.pendingAuth).toBeNull();
      expect(DEFAULT_SETTINGS.remoteFolder).toBe('');
      expect(DEFAULT_SETTINGS.deviceName).toBe('');
      expect(DEFAULT_SETTINGS.excludes).toEqual([]);
      expect(DEFAULT_SETTINGS.verboseLogging).toBe(false);
    });
  });
});
