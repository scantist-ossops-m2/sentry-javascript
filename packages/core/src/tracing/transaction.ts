import type {
  Context,
  Contexts,
  DynamicSamplingContext,
  MeasurementUnit,
  Measurements,
  SpanTimeInput,
  Transaction as TransactionInterface,
  TransactionContext,
  TransactionEvent,
  TransactionMetadata,
} from '@sentry/types';
import { dropUndefinedKeys, logger } from '@sentry/utils';

import { DEBUG_BUILD } from '../debug-build';
import type { Hub } from '../hub';
import { getCurrentHub } from '../hub';
import { SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE, SEMANTIC_ATTRIBUTE_SENTRY_SOURCE } from '../semanticAttributes';
import { spanTimeInputToSeconds, spanToTraceContext } from '../utils/spanUtils';
import { getDynamicSamplingContextFromClient } from './dynamicSamplingContext';
import { Span as SpanClass, SpanRecorder } from './span';

/** JSDoc */
export class Transaction extends SpanClass implements TransactionInterface {
  /**
   * The reference to the current hub.
   */
  public _hub: Hub;

  protected _name: string;

  private _measurements: Measurements;

  private _contexts: Contexts;

  private _trimEnd?: boolean;

  private _frozenDynamicSamplingContext: Readonly<Partial<DynamicSamplingContext>> | undefined;

  private _metadata: Partial<TransactionMetadata>;

  /**
   * This constructor should never be called manually. Those instrumenting tracing should use
   * `Sentry.startTransaction()`, and internal methods should use `hub.startTransaction()`.
   * @internal
   * @hideconstructor
   * @hidden
   */
  public constructor(transactionContext: TransactionContext, hub?: Hub) {
    super(transactionContext);
    this._measurements = {};
    this._contexts = {};

    this._hub = hub || getCurrentHub();

    this._name = transactionContext.name || '';

    this._metadata = {
      // eslint-disable-next-line deprecation/deprecation
      ...transactionContext.metadata,
    };

    this._trimEnd = transactionContext.trimEnd;

    // this is because transactions are also spans, and spans have a transaction pointer
    this.transaction = this;

    // If Dynamic Sampling Context is provided during the creation of the transaction, we freeze it as it usually means
    // there is incoming Dynamic Sampling Context. (Either through an incoming request, a baggage meta-tag, or other means)
    const incomingDynamicSamplingContext = this._metadata.dynamicSamplingContext;
    if (incomingDynamicSamplingContext) {
      // We shallow copy this in case anything writes to the original reference of the passed in `dynamicSamplingContext`
      this._frozenDynamicSamplingContext = { ...incomingDynamicSamplingContext };
    }
  }

  // This sadly conflicts with the getter/setter ordering :(
  /* eslint-disable @typescript-eslint/member-ordering */

  /**
   * Getter for `name` property.
   * @deprecated Use `spanToJSON(span).description` instead.
   */
  public get name(): string {
    return this._name;
  }

  /**
   * Setter for `name` property, which also sets `source` as custom.
   * @deprecated Use `updateName()` and `setMetadata()` instead.
   */
  public set name(newName: string) {
    // eslint-disable-next-line deprecation/deprecation
    this.setName(newName);
  }

  /**
   * Get the metadata for this transaction.
   * @deprecated Use `spanGetMetadata(transaction)` instead.
   */
  public get metadata(): TransactionMetadata {
    // We merge attributes in for backwards compatibility
    return {
      // Defaults
      // eslint-disable-next-line deprecation/deprecation
      source: 'custom',
      spanMetadata: {},

      // Legacy metadata
      ...this._metadata,

      // From attributes
      ...(this._attributes[SEMANTIC_ATTRIBUTE_SENTRY_SOURCE] && {
        source: this._attributes[SEMANTIC_ATTRIBUTE_SENTRY_SOURCE] as TransactionMetadata['source'],
      }),
      ...(this._attributes[SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE] && {
        sampleRate: this._attributes[SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE] as TransactionMetadata['sampleRate'],
      }),
    };
  }

  /**
   * Update the metadata for this transaction.
   * @deprecated Use `spanGetMetadata(transaction)` instead.
   */
  public set metadata(metadata: TransactionMetadata) {
    this._metadata = metadata;
  }

  /* eslint-enable @typescript-eslint/member-ordering */

  /**
   * Setter for `name` property, which also sets `source` on the metadata.
   *
   * @deprecated Use `updateName()` and `setMetadata()` instead.
   */
  public setName(name: string, source: TransactionMetadata['source'] = 'custom'): void {
    this._name = name;
    this.setAttribute(SEMANTIC_ATTRIBUTE_SENTRY_SOURCE, source);
  }

  /** @inheritdoc */
  public updateName(name: string): this {
    this._name = name;
    return this;
  }

  /**
   * Attaches SpanRecorder to the span itself
   * @param maxlen maximum number of spans that can be recorded
   */
  public initSpanRecorder(maxlen: number = 1000): void {
    if (!this.spanRecorder) {
      this.spanRecorder = new SpanRecorder(maxlen);
    }
    this.spanRecorder.add(this);
  }

  /**
   * Set the context of a transaction event.
   * @deprecated Use either `.setAttribute()`, or set the context on the scope before creating the transaction.
   */
  public setContext(key: string, context: Context | null): void {
    if (context === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this._contexts[key];
    } else {
      this._contexts[key] = context;
    }
  }

  /**
   * @inheritDoc
   */
  public setMeasurement(name: string, value: number, unit: MeasurementUnit = ''): void {
    this._measurements[name] = { value, unit };
  }

  /**
   * Store metadata on this transaction.
   * @deprecated Use attributes or store data on the scope instead.
   */
  public setMetadata(newMetadata: Partial<TransactionMetadata>): void {
    this._metadata = { ...this._metadata, ...newMetadata };
  }

  /**
   * @inheritDoc
   */
  public end(endTimestamp?: SpanTimeInput): string | undefined {
    const timestampInS = spanTimeInputToSeconds(endTimestamp);
    const transaction = this._finishTransaction(timestampInS);
    if (!transaction) {
      return undefined;
    }
    // eslint-disable-next-line deprecation/deprecation
    return this._hub.captureEvent(transaction);
  }

  /**
   * @inheritDoc
   */
  public toContext(): TransactionContext {
    // eslint-disable-next-line deprecation/deprecation
    const spanContext = super.toContext();

    return dropUndefinedKeys({
      ...spanContext,
      name: this._name,
      trimEnd: this._trimEnd,
    });
  }

  /**
   * @inheritDoc
   */
  public updateWithContext(transactionContext: TransactionContext): this {
    // eslint-disable-next-line deprecation/deprecation
    super.updateWithContext(transactionContext);

    this._name = transactionContext.name || '';
    this._trimEnd = transactionContext.trimEnd;

    return this;
  }

  /**
   * @inheritdoc
   *
   * @experimental
   */
  public getDynamicSamplingContext(): Readonly<Partial<DynamicSamplingContext>> {
    if (this._frozenDynamicSamplingContext) {
      return this._frozenDynamicSamplingContext;
    }

    const hub = this._hub || getCurrentHub();
    const client = hub.getClient();

    if (!client) return {};

    const { _traceId: traceId, _sampled: sampled } = this;

    const scope = hub.getScope();
    const dsc = getDynamicSamplingContextFromClient(traceId, client, scope);

    // eslint-disable-next-line deprecation/deprecation
    const maybeSampleRate = this.metadata.sampleRate;
    if (maybeSampleRate !== undefined) {
      dsc.sample_rate = `${maybeSampleRate}`;
    }

    // We don't want to have a transaction name in the DSC if the source is "url" because URLs might contain PII
    // eslint-disable-next-line deprecation/deprecation
    const source = this.metadata.source;
    if (source && source !== 'url') {
      dsc.transaction = this._name;
    }

    if (sampled !== undefined) {
      dsc.sampled = String(sampled);
    }

    // Uncomment if we want to make DSC immutable
    // this._frozenDynamicSamplingContext = dsc;

    return dsc;
  }

  /**
   * Override the current hub with a new one.
   * Used if you want another hub to finish the transaction.
   *
   * @internal
   */
  public setHub(hub: Hub): void {
    this._hub = hub;
  }

  /**
   * Finish the transaction & prepare the event to send to Sentry.
   */
  protected _finishTransaction(endTimestamp?: number): TransactionEvent | undefined {
    // This transaction is already finished, so we should not flush it again.
    if (this.endTimestamp !== undefined) {
      return undefined;
    }

    if (!this._name) {
      DEBUG_BUILD && logger.warn('Transaction has no name, falling back to `<unlabeled transaction>`.');
      this._name = '<unlabeled transaction>';
    }

    // just sets the end timestamp
    super.end(endTimestamp);

    const client = this._hub.getClient();
    if (client && client.emit) {
      client.emit('finishTransaction', this);
    }

    if (this._sampled !== true) {
      // At this point if `sampled !== true` we want to discard the transaction.
      DEBUG_BUILD && logger.log('[Tracing] Discarding transaction because its trace was not chosen to be sampled.');

      if (client) {
        client.recordDroppedEvent('sample_rate', 'transaction');
      }

      return undefined;
    }

    const finishedSpans = this.spanRecorder ? this.spanRecorder.spans.filter(s => s !== this && s.endTimestamp) : [];

    if (this._trimEnd && finishedSpans.length > 0) {
      this.endTimestamp = finishedSpans.reduce((prev: SpanClass, current: SpanClass) => {
        if (prev.endTimestamp && current.endTimestamp) {
          return prev.endTimestamp > current.endTimestamp ? prev : current;
        }
        return prev;
      }).endTimestamp;
    }

    // eslint-disable-next-line deprecation/deprecation
    const { metadata } = this;
    // eslint-disable-next-line deprecation/deprecation
    const { source } = metadata;

    const transaction: TransactionEvent = {
      contexts: {
        ...this._contexts,
        // We don't want to override trace context
        trace: spanToTraceContext(this),
      },
      // TODO: Pass spans serialized via `spanToJSON()` here instead in v8.
      spans: finishedSpans,
      start_timestamp: this.startTimestamp,
      // eslint-disable-next-line deprecation/deprecation
      tags: this.tags,
      timestamp: this.endTimestamp,
      transaction: this._name,
      type: 'transaction',
      sdkProcessingMetadata: {
        ...metadata,
        dynamicSamplingContext: this.getDynamicSamplingContext(),
      },
      ...(source && {
        transaction_info: {
          source,
        },
      }),
    };

    const hasMeasurements = Object.keys(this._measurements).length > 0;

    if (hasMeasurements) {
      DEBUG_BUILD &&
        logger.log(
          '[Measurements] Adding measurements to transaction',
          JSON.stringify(this._measurements, undefined, 2),
        );
      transaction.measurements = this._measurements;
    }

    DEBUG_BUILD && logger.log(`[Tracing] Finishing ${this.op} transaction: ${this._name}.`);

    return transaction;
  }
}
