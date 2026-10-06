import errors from '@tryghost/errors';
import { service } from '../../services/app-installations';

interface Frame {
  data: Record<string, unknown>;
}

const controller = {
  docName: 'app_installation_previews',

  // Fetches and checks an app's manifest so the publisher can review it before installing
  // or approving it. Nothing is stored. Making Ghost fetch a URL is part of installing, so
  // it takes the permission to install.
  add: {
    headers: { cacheInvalidate: false },
    permissions: { docName: 'app_installations', method: 'add' },
    query(frame: Frame) {
      const [input] = (frame.data?.app_installation_previews ?? []) as Array<
        Record<string, unknown>
      >;
      if (typeof input?.manifest_url !== 'string') {
        throw new errors.ValidationError({ message: 'Expected the manifest_url to preview.' });
      }
      return service!.preview(input.manifest_url);
    },
  },
};

module.exports = controller;
