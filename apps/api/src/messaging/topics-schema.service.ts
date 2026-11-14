import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';

/** While the update is missing, each server instance looks again this often (the owner may run it at any time). */
export const TOPICS_RECHECK_MISSING_MS = 60_000;
/** Once seen, it is confirmed again now and then (cheap: one catalogue query per instance). */
export const TOPICS_RECHECK_PRESENT_MS = 15 * 60_000;

/** Postgres: undefined table, undefined column (the database update for topics has not been run). */
const MISSING_SCHEMA_CODES = new Set(['42P01', '42703']);

/** Whether an error says the topic tables or app.messages.topic_id do not exist (yet). */
export function isMissingTopicsSchema(error: unknown): boolean {
  return MISSING_SCHEMA_CODES.has((error as { code?: string } | null)?.code ?? '');
}

/**
 * D-63: whether the database has topics (update 20261115130000: app.group_topic_settings, app.group_topics and
 * app.messages.topic_id). The site is deployed before the owner runs the update, so nothing that every chat uses may
 * name the new column until it exists: the message queries ask this service which columns to read, and every topic
 * route answers "not available" until then. The answer is cached per server instance (one catalogue query, shared by
 * concurrent requests) and looked up again every minute while missing, so topics appear within a minute of the update
 * without a new deploy. A query that still finds the schema missing (42P01 / 42703) marks it missing again.
 */
@Injectable()
export class TopicsSchemaService {
  private readonly logger = new Logger(TopicsSchemaService.name);
  private known: { available: boolean; until: number } | null = null;
  private probing: Promise<boolean> | null = null;

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Whether topics can be used now (cached; see the class comment). Never throws. */
  async available(): Promise<boolean> {
    const known = this.known;
    if (known && Date.now() < known.until) return known.available;
    this.probing ??= this.probe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  /** A topic query found the schema missing after all: treat topics as unavailable until the next look. */
  markMissing(): void {
    this.known = { available: false, until: Date.now() + TOPICS_RECHECK_MISSING_MS };
  }

  /** Forgets the cached answer (tests, and right after the update in a test run). */
  forget(): void {
    this.known = null;
  }

  private async probe(): Promise<boolean> {
    try {
      const { rows } = await sql<{ ok: boolean }>`
        select (
          to_regclass('app.group_topic_settings') is not null
          and to_regclass('app.group_topics') is not null
          and exists (
            select 1 from pg_catalog.pg_attribute
            where attrelid = 'app.messages'::regclass and attname = 'topic_id' and not attisdropped
          )
        ) as ok
      `.execute(this.database.db);
      const available = rows[0]?.ok === true;
      this.known = { available, until: Date.now() + (available ? TOPICS_RECHECK_PRESENT_MS : TOPICS_RECHECK_MISSING_MS) };
      return available;
    } catch (error) {
      // The database is briefly unreachable: no topics for this request, and no long-lived answer either.
      this.logger.warn(`Could not check for the topics update: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
