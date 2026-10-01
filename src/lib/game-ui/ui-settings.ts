export type GameUiSettings = Readonly<{
  showCountryLabels: boolean;
  showCapitalMarkers: boolean;
  emphasizeBorders: boolean;
  showNewsNotifications: boolean;
  reduceMotion: boolean;
}>;

export const DEFAULT_GAME_UI_SETTINGS: GameUiSettings = Object.freeze({
  showCountryLabels: true,
  showCapitalMarkers: true,
  emphasizeBorders: false,
  showNewsNotifications: true,
  reduceMotion: false,
});

export type GameUiSettingKey = keyof GameUiSettings;
