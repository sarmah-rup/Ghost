import { createHash } from 'node:crypto';
import errors from '@tryghost/errors';
import ObjectId from 'bson-objectid';
import type { Knex } from 'knex';
import {
  compareManifests,
  parseManifest,
  type AppManifest,
} from '@tryghost/app-contracts/manifest';
import { fromDatabaseDate, toDatabaseDate, type DatabaseDate } from '../../lib/db-types/date';
import type { RecordAppInstallationAction, RequestContext } from './actions';
import type { FetchManifest } from './fetch-manifest';

const INSTALLATIONS = 'app_installations';
const MANIFESTS = 'app_installation_manifests';
// The width of the manifest_url column.
const MANIFEST_URL_MAX_LENGTH = 2000;

export type AppInstallationStatus = 'active' | 'suspended' | 'uninstalled';

/** An installation, joined with the approved manifest it runs. */
interface AppInstallationRow {
  id: string;
  app_id: string;
  status: AppInstallationStatus;
  manifest_url: string;
  manifest: string;
  created_at: DatabaseDate;
  updated_at: DatabaseDate | null;
}

/** One site's approval of one app, as the Admin API returns it. */
export interface AppInstallation {
  id: string;
  app_id: string;
  status: AppInstallationStatus;
  manifest_url: string;
  manifest: AppManifest;
  created_at: Date;
  updated_at: Date | null;
}

/** One field that differs from what the publisher approved. */
export interface AppManifestChange {
  /** Where the change is: a path in the manifest, or `manifest_url` when the app moved. */
  path: string;
  requires_approval: boolean;
}

/** What a publisher reviews before installing an app, or before approving changes to one. */
export interface AppInstallationPreview {
  manifest_url: string;
  manifest: AppManifest;
  /** Confirming sends this back, so only the manifest that was reviewed gets installed. */
  digest: string;
  /** The installation of the same app, if the site already has one, and what would change. */
  installation: {
    id: string;
    status: AppInstallationStatus;
    changes: AppManifestChange[];
  } | null;
}

/** A manifest Ghost has fetched and validated, ready to store. */
interface LoadedManifest {
  manifestUrl: string;
  manifest: AppManifest;
  serialised: string;
  digest: string;
}

/** The current installation of an app, with the manifest it was approved with. */
interface CurrentInstallationRow {
  id: string;
  status: AppInstallationStatus;
  manifest_id: string;
  pending_manifest_id: string | null;
  manifest_url: string;
  manifest: string;
  digest: string;
}

function toInstallation(row: AppInstallationRow): AppInstallation {
  return {
    id: row.id,
    app_id: row.app_id,
    status: row.status,
    manifest_url: row.manifest_url,
    manifest: JSON.parse(row.manifest) as AppManifest,
    created_at: fromDatabaseDate(row.created_at),
    updated_at: row.updated_at === null ? null : fromDatabaseDate(row.updated_at),
  };
}

/**
 * What a publisher reviews and confirms. The same manifest always serialises the same way,
 * as parsing builds it in the schema's key order.
 */
function digestOf(serialisedManifest: string): string {
  return createHash('sha256').update(serialisedManifest).digest('hex');
}

function assertStorableUrl(manifestUrl: string): void {
  if (manifestUrl.length > MANIFEST_URL_MAX_LENGTH) {
    throw new errors.ValidationError({ message: 'The app manifest URL is too long.' });
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === 'ER_DUP_ENTRY' || (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT'))
  );
}

/** What the manifest is checked against: where Ghost is served from, and in which mode. */
export interface ManifestRules {
  ghostUrls: string[];
  allowLocalhost: boolean;
}

export class AppInstallationsService {
  private knex: Knex;
  private recordAction: RecordAppInstallationAction;
  private getManifestRules: () => ManifestRules;
  private fetchManifest: FetchManifest;

  constructor({
    knex,
    recordAction,
    getManifestRules,
    fetchManifest,
  }: {
    knex: Knex;
    recordAction: RecordAppInstallationAction;
    getManifestRules: () => ManifestRules;
    fetchManifest: FetchManifest;
  }) {
    this.knex = knex;
    this.recordAction = recordAction;
    this.getManifestRules = getManifestRules;
    this.fetchManifest = fetchManifest;
  }

  /** Installations with the approved manifest each one runs. */
  private withApprovedManifest() {
    return this.knex(`${INSTALLATIONS} as installation`)
      .join(`${MANIFESTS} as approved`, 'approved.id', 'installation.manifest_id')
      .select<AppInstallationRow[]>(
        'installation.id',
        'installation.app_id',
        'installation.status',
        'approved.manifest_url',
        'approved.manifest',
        'installation.created_at',
        'installation.updated_at',
      );
  }

  /** The apps installed on this site now, suspended ones included. Ended ones are not listed. */
  async browse(): Promise<AppInstallation[]> {
    const rows = await this.withApprovedManifest()
      .whereNot('installation.status', 'uninstalled')
      .orderBy('installation.created_at', 'asc')
      .orderBy('installation.id', 'asc');
    return rows.map(toInstallation);
  }

  /** One installation by ID, whether it has ended or not. */
  async read(id: string): Promise<AppInstallation> {
    const [row] = await this.withApprovedManifest().where('installation.id', id);
    if (!row) {
      throw new errors.NotFoundError({ message: 'App installation not found.' });
    }
    return toInstallation(row);
  }

  /**
   * Validates a manifest and resolves its URLs against `baseUrl`, where it was read from.
   * `manifestUrl` is what gets stored: the address the install link pointed at, which
   * later checks fetch again.
   */
  private load(manifestUrl: string, body: unknown, baseUrl = manifestUrl): LoadedManifest {
    assertStorableUrl(manifestUrl);
    const parsed = parseManifest(body, { manifestUrl: baseUrl, ...this.getManifestRules() });
    if (!parsed.success) {
      throw new errors.ValidationError({
        message: 'The app manifest is not valid.',
        code: 'APP_MANIFEST_INVALID',
        context: parsed.errors
          .map(({ path, message }) => (path ? `${path}: ${message}` : message))
          .join('; '),
      });
    }
    const serialised = JSON.stringify(parsed.manifest);
    return { manifestUrl, manifest: parsed.manifest, serialised, digest: digestOf(serialised) };
  }

  private async fetchAndLoad(manifestUrl: string): Promise<LoadedManifest> {
    assertStorableUrl(manifestUrl);
    const fetched = await this.fetchManifest(manifestUrl);
    return this.load(manifestUrl, fetched.body, fetched.url);
  }

  private currentInstallation(
    appId: string,
    db: Knex | Knex.Transaction = this.knex,
  ): Promise<CurrentInstallationRow | undefined> {
    return db(`${INSTALLATIONS} as installation`)
      .join(`${MANIFESTS} as approved`, 'approved.id', 'installation.manifest_id')
      .where('installation.current_app_id', appId)
      .first<CurrentInstallationRow | undefined>(
        'installation.id',
        'installation.status',
        'installation.manifest_id',
        'installation.pending_manifest_id',
        'approved.manifest_url',
        'approved.manifest',
        'approved.digest',
      );
  }

  private changesFrom(current: CurrentInstallationRow, loaded: LoadedManifest) {
    const { changes } = compareManifests(
      JSON.parse(current.manifest) as AppManifest,
      loaded.manifest,
    );
    const result: AppManifestChange[] = changes.map(({ path, requiresApproval }) => ({
      path,
      requires_approval: requiresApproval,
    }));
    // Where the manifest lives decides what future updates say, so a move needs approval
    // even when every URL in the manifest stays the same.
    if (current.manifest_url !== loaded.manifestUrl) {
      result.unshift({ path: 'manifest_url', requires_approval: true });
    }
    return result;
  }

  private async previewOf(loaded: LoadedManifest): Promise<AppInstallationPreview> {
    const current = await this.currentInstallation(loaded.manifest.id);
    return {
      manifest_url: loaded.manifestUrl,
      manifest: loaded.manifest,
      digest: loaded.digest,
      installation: current
        ? { id: current.id, status: current.status, changes: this.changesFrom(current, loaded) }
        : null,
    };
  }

  /** Fetches and checks an app's manifest, for the publisher to review. Stores nothing. */
  async preview(manifestUrl: string): Promise<AppInstallationPreview> {
    return this.previewOf(await this.fetchAndLoad(manifestUrl));
  }

  /**
   * Fetches the manifest again and checks it is the one the publisher reviewed. If the app
   * changed in between, the publisher is asked to review the new version instead.
   */
  private async fetchReviewed(manifestUrl: string, digest: string): Promise<LoadedManifest> {
    const loaded = await this.fetchAndLoad(manifestUrl);
    if (loaded.digest !== digest) {
      throw new errors.ConflictError({
        message: 'The app changed while it was being reviewed.',
        code: 'APP_MANIFEST_CHANGED',
        errorDetails: await this.previewOf(loaded),
      });
    }
    return loaded;
  }

  /** Installs an app after the publisher has reviewed its manifest, as previewed. */
  async create(
    context: RequestContext,
    { manifestUrl, digest }: { manifestUrl: string; digest: string },
  ): Promise<AppInstallation> {
    return this.insert(context, await this.fetchReviewed(manifestUrl, digest));
  }

  /**
   * Installs an app from a manifest that has already been fetched, without a review. Only
   * for code and the REPL: anything a publisher confirms goes through `create`.
   */
  async install(
    context: RequestContext,
    { manifestUrl, manifest }: { manifestUrl: string; manifest: unknown },
  ): Promise<AppInstallation> {
    return this.insert(context, this.load(manifestUrl, manifest));
  }

  /**
   * Every install is a new installation with a new ID, including a reinstall: an ended
   * installation is never brought back. The unique `current_app_id` is what refuses a
   * second installation of the same app, so two confirmations racing each other end with
   * exactly one installed and the other told so.
   */
  private async insert(context: RequestContext, loaded: LoadedManifest): Promise<AppInstallation> {
    const { manifest } = loaded;
    const id = new ObjectId().toHexString();
    const manifestId = new ObjectId().toHexString();
    const now = toDatabaseDate(new Date());
    try {
      await this.knex.transaction(async (trx) => {
        await trx(INSTALLATIONS).insert({
          id,
          app_id: manifest.id,
          current_app_id: manifest.id,
          status: 'active',
          manifest_id: manifestId,
          created_at: now,
          updated_at: now,
        });
        await trx(MANIFESTS).insert({
          id: manifestId,
          installation_id: id,
          manifest_url: loaded.manifestUrl,
          manifest: loaded.serialised,
          digest: loaded.digest,
          requires_approval: false,
          created_at: now,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new errors.ConflictError({
          message: `The app ${manifest.id} is already installed.`,
          code: 'APP_ALREADY_INSTALLED',
        });
      }
      throw err;
    }

    await this.recordAction({
      context,
      event: 'installed',
      subject: id,
      details: { primary_name: manifest.name, app_id: manifest.id },
    });
    return this.read(id);
  }

  /**
   * Approves the manifest the publisher reviewed for an installation they already have:
   * changes waiting for approval, or the same app served from somewhere new. The
   * installation keeps its ID and history, and runs the reviewed manifest from now on.
   *
   * Approving what is already approved changes nothing and records nothing.
   */
  async approve(
    context: RequestContext,
    id: string,
    { manifestUrl, digest }: { manifestUrl: string; digest: string },
  ): Promise<AppInstallation> {
    await this.read(id);
    const loaded = await this.fetchReviewed(manifestUrl, digest);

    const approved = await this.knex.transaction(async (trx) => {
      await trx(INSTALLATIONS).where({ id }).forUpdate().first();
      const current = await this.currentInstallation(loaded.manifest.id, trx);
      // The reviewed manifest must belong to this installation, and it must still be
      // installed: anything else is not what the publisher was shown.
      if (!current || current.id !== id) {
        throw new errors.ConflictError({
          message: 'This installation is not the one for the app that was reviewed.',
          code: 'APP_INSTALLATION_CHANGED',
        });
      }

      const unchanged =
        current.digest === loaded.digest &&
        current.manifest_url === loaded.manifestUrl &&
        current.status === 'active' &&
        current.pending_manifest_id === null;
      if (unchanged) {
        return null;
      }

      const manifestId = new ObjectId().toHexString();
      const now = toDatabaseDate(new Date());
      await trx(MANIFESTS).insert({
        id: manifestId,
        installation_id: id,
        manifest_url: loaded.manifestUrl,
        manifest: loaded.serialised,
        digest: loaded.digest,
        requires_approval: this.changesFrom(current, loaded).some(
          (change) => change.requires_approval,
        ),
        created_at: now,
      });
      await trx(INSTALLATIONS)
        .where({ id })
        .update({
          status: 'active',
          manifest_id: manifestId,
          pending_manifest_id: null,
          revision: trx.raw('?? + 1', ['revision']),
          updated_at: now,
        });
      return { from: current.manifest_id, to: manifestId };
    });

    if (approved) {
      await this.recordAction({
        context,
        event: 'changes_approved',
        subject: id,
        details: {
          primary_name: loaded.manifest.name,
          app_id: loaded.manifest.id,
          from_manifest_id: approved.from,
          to_manifest_id: approved.to,
        },
      });
    }
    return this.read(id);
  }

  /**
   * Ends an installation. The row stays, so the site keeps a record of what was installed.
   *
   * Uninstalling one that has already ended does nothing and records nothing, so a
   * repeated request cannot add a second uninstall to the history.
   */
  async uninstall(context: RequestContext, id: string): Promise<void> {
    const installation = await this.read(id);

    const ended = await this.knex(INSTALLATIONS)
      .where({ id })
      .whereNot('status', 'uninstalled')
      .update({
        current_app_id: null,
        status: 'uninstalled',
        revision: this.knex.raw('?? + 1', ['revision']),
        updated_at: toDatabaseDate(new Date()),
      });
    if (ended === 0) {
      return;
    }

    await this.recordAction({
      context,
      event: 'uninstalled',
      subject: id,
      details: { primary_name: installation.manifest.name, app_id: installation.app_id },
    });
  }
}
