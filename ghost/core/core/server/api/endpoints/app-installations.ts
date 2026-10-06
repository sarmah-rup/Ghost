import errors from '@tryghost/errors';
import { actingContext, service } from '../../services/app-installations';

interface Frame {
  options: {
    id: string;
    context: unknown;
    [key: string]: unknown;
  };
  data: Record<string, unknown>;
}

/**
 * What a publisher confirms: the manifest URL they reviewed and the digest of the manifest
 * they were shown. The manifest itself never comes from the browser.
 */
function reviewed(frame: Frame): { manifestUrl: string; digest: string } {
  const [input] = (frame.data?.app_installations ?? []) as Array<Record<string, unknown>>;
  const manifestUrl = input?.manifest_url;
  const digest = input?.digest;
  if (typeof manifestUrl !== 'string' || typeof digest !== 'string') {
    throw new errors.ValidationError({
      message: 'Expected the manifest_url and digest of the reviewed manifest.',
    });
  }
  return { manifestUrl, digest };
}

const noCacheInvalidation = { cacheInvalidate: false };

const controller = {
  docName: 'app_installations',

  browse: {
    headers: noCacheInvalidation,
    permissions: true,
    async query() {
      return { data: await service!.browse() };
    },
  },

  read: {
    headers: noCacheInvalidation,
    options: ['id'],
    validation: { options: { id: { required: true } } },
    permissions: true,
    query(frame: Frame) {
      return service!.read(frame.options.id);
    },
  },

  add: {
    statusCode: 201,
    headers: noCacheInvalidation,
    permissions: true,
    query(frame: Frame) {
      return service!.create(actingContext(frame.options.context), reviewed(frame));
    },
  },

  // Approves changes to an installation, including the app moving somewhere new. Approving
  // is a decision of the same weight as installing, so it takes the same permission.
  edit: {
    headers: noCacheInvalidation,
    options: ['id'],
    validation: { options: { id: { required: true } } },
    permissions: { method: 'add' },
    query(frame: Frame) {
      return service!.approve(
        actingContext(frame.options.context),
        frame.options.id,
        reviewed(frame),
      );
    },
  },

  destroy: {
    statusCode: 204,
    headers: noCacheInvalidation,
    options: ['id'],
    validation: { options: { id: { required: true } } },
    permissions: true,
    query(frame: Frame) {
      return service!.uninstall(actingContext(frame.options.context), frame.options.id);
    },
  },
};

module.exports = controller;
