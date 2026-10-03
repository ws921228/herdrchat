import { fireEvent, render } from '@testing-library/react-native';

import { ThreadPlaceholder } from '../ThreadPlaceholders';

jest.mock('react-native-worklets', () => jest.requireActual('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => jest.requireActual('react-native-reanimated/mock'));
jest.mock('@/theme/ThemeProvider', () => ({
  useTheme: () => ({ colors: jest.requireActual('@/theme/tokens').darkPalette }),
}));

it('names the Hermes integration and tells the reader to resume the same idle session', async () => {
  const install = jest.fn();
  const screen = await render(
    <ThreadPlaceholder
      waiting={false}
      loading={false}
      canSend={false}
      title="Hermes chat"
      sessionState="missing"
      agentKind="hermes"
      onInstallIntegration={install}
      installing={false}
      installError="Plugin missing"
    />
  );

  expect(screen.getAllByText(/Hermes session/).length).toBeGreaterThan(0);
  expect(screen.getByText(/same Hermes session/)).toBeOnTheScreen();
  expect(screen.getByText(/herdr integration install hermes/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('install-integration'));
  expect(install).toHaveBeenCalledTimes(1);
});
