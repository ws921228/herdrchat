const forkEnabled = process.env.HERDRCHAT_TESTFLIGHT_FORK === '1';

module.exports = ({ config }) => {
  if (!forkEnabled) {
    return config;
  }

  return {
    ...config,
    name: process.env.HERDRCHAT_APP_NAME || 'HerdrChat Hermes',
    slug: process.env.HERDRCHAT_APP_SLUG || 'herdrchat-hermes',
    scheme: process.env.HERDRCHAT_URL_SCHEME || 'herdrchat-hermes',
    ios: {
      ...config.ios,
      bundleIdentifier: process.env.HERDRCHAT_IOS_BUNDLE_ID || 'com.ws9212.herdrchat.hermes',
      buildNumber: process.env.HERDRCHAT_IOS_BUILD_NUMBER || '1',
    },
  };
};
