/**
 * The development flag, in one place.
 *
 * There is no bundler any more, so there is no `import.meta.env.DEV` for a build step to
 * substitute - the browser loads these files exactly as written. `?dev=1` is the switch
 * instead, which has the advantage of working on the deployed site too: the debug panel
 * and the state-machine warnings are reachable in production without a special build.
 */
export const DEV = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('dev') === '1';
