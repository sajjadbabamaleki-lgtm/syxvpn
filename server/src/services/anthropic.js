/**
 * The Claude client the support assistant talks through.
 *
 * A file of its own for one reason: everything else in this service can be
 * tested without a network, and this is the single place that cannot. Nothing
 * imports it except the entry point, so a test builds an assistant around a
 * stub and never comes near it.
 *
 * The key is read from the environment by the SDK itself (`ANTHROPIC_API_KEY`),
 * so it is never held in the config object and never reaches a log line.
 */

import Anthropic from '@anthropic-ai/sdk';

export function createAnthropic() {
  return new Anthropic();
}
