import Transport from 'winston-transport';
import { Kafka, Producer, KafkaConfig, ProducerConfig, ProducerRecord, Message } from 'kafkajs';
import { LogEntry } from 'winston';

/**
 * Configuration options for KafkaTransport
 */
export interface KafkaTransportOptions extends Transport.TransportStreamOptions {
  /** Kafka broker addresses */
  brokers?: string[];

  /** Kafka client ID */
  clientId?: string;

  /** Kafka topic to send logs to */
  topic?: string;

  /** Field from log entry to use as Kafka message key */
  keyField?: string;

  /** Custom function to format log messages */
  messageFormatter?: (info: LogEntry) => any;

  /** KafkaJS producer configuration (default retry: { retries: 2 }) */
  producerConfig?: ProducerConfig;

  /** Full KafkaJS client configuration (overrides brokers/clientId) */
  kafka?: KafkaConfig;

  /** Maximum messages to queue while disconnected (default: 1000) */
  maxQueueSize?: number;

  /** Delay between reconnect attempts in ms (default: 5000) */
  reconnectInterval?: number;
}

/**
 * Default formatted log message structure
 */
interface FormattedLogMessage {
  timestamp: string;
  level: string;
  message: string;
  [key: string]: any;
}

const CONNECTION_ERRORS = new Set([
  'KafkaJSConnectionError',
  'KafkaJSConnectionClosedError',
  'KafkaJSRequestTimeoutError',
  'KafkaJSBrokerNotFound',
]);

/**
 * Custom Kafka Transport for Winston
 * Sends log messages to Apache Kafka topics with full TypeScript support.
 *
 * The transport never blocks the logger: winston's callback is invoked
 * immediately and messages are sent in the background. While Kafka is
 * unreachable, messages are buffered (up to maxQueueSize) and flushed on
 * reconnect. Failures are reported via 'warn' and 'kafkaError' events,
 * never 'error', because winston re-throws transport errors on the logger.
 */
export class KafkaTransport extends Transport {
  private kafkaConfig: KafkaConfig;
  private producerConfig: ProducerConfig;
  private topic: string;
  private keyField: string | null;
  private messageFormatter: (info: LogEntry) => any;
  private kafka: Kafka;
  private producer: Producer;
  private connected: boolean = false;
  private connecting: boolean = false;
  private closing: boolean = false;
  private flushing: boolean = false;
  private messageQueue: LogEntry[] = [];
  private maxQueueSize: number;
  private reconnectInterval: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private droppedCount: number = 0;

  constructor(opts: KafkaTransportOptions = {}) {
    super(opts);

    this.kafkaConfig = opts.kafka || {
      clientId: opts.clientId || 'winston-kafka-logger',
      brokers: opts.brokers || ['localhost:9092'],
    };

    this.producerConfig = { retry: { retries: 2 }, ...opts.producerConfig };

    this.topic = opts.topic || 'logs';
    this.keyField = opts.keyField || null;

    this.maxQueueSize = opts.maxQueueSize || 1000;
    this.reconnectInterval = opts.reconnectInterval || 5000;

    this.messageFormatter = opts.messageFormatter || this.defaultFormatter.bind(this);

    this.kafka = new Kafka(this.kafkaConfig);
    this.producer = this.kafka.producer(this.producerConfig);

    this.producer.on(this.producer.events.DISCONNECT, () => {
      this.markDisconnected();
    });

    this.connect();
  }

  /**
   * Connect to Kafka broker
   */
  private async connect(): Promise<void> {
    if (this.connecting || this.connected || this.closing) return;

    this.connecting = true;

    try {
      await this.producer.connect();
      this.connected = true;
      this.connecting = false;
      this.emit('connected');

      if (this.droppedCount > 0) {
        this.warn(new Error(`Dropped ${this.droppedCount} log messages while disconnected from Kafka.`));
        this.droppedCount = 0;
      }

      await this.processQueue();
    } catch (error) {
      this.connecting = false;
      this.warn(error);
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnect attempt; the timer does not keep the process alive
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closing) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
    this.reconnectTimer.unref();
  }

  /**
   * Switch to queueing mode and start reconnecting
   */
  private markDisconnected(): void {
    const wasConnected = this.connected;
    this.connected = false;

    if (wasConnected) {
      this.emit('disconnected');
    }

    this.scheduleReconnect();
  }

  /**
   * Process queued messages
   */
  private async processQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      while (this.connected && this.messageQueue.length > 0) {
        const info = this.messageQueue.shift() as LogEntry;

        try {
          await this.sendToKafka(info);
        } catch (error) {
          this.handleSendError(info, error, true);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Buffer a message while disconnected, dropping it when the queue is full
   */
  private enqueue(info: LogEntry, front: boolean = false): void {
    if (this.messageQueue.length < this.maxQueueSize) {
      if (front) {
        this.messageQueue.unshift(info);
      } else {
        this.messageQueue.push(info);
      }
      return;
    }

    if (this.droppedCount === 0) {
      this.warn(new Error(`Message queue full (${this.maxQueueSize} messages). Dropping logs until Kafka reconnects.`));
    }
    this.droppedCount++;
  }

  /**
   * Re-queue messages that failed due to connection problems, drop the rest
   */
  private handleSendError(info: LogEntry, error: unknown, front: boolean = false): void {
    if (isConnectionError(error)) {
      this.enqueue(info, front);
      this.markDisconnected();
      return;
    }

    this.warn(error);
  }

  /**
   * Report a problem without emitting 'error' (winston re-throws it on the logger)
   */
  private warn(error: unknown): void {
    this.emit('kafkaError', error);
    this.emit('warn', error);
  }

  /**
   * Default message formatter
   */
  private defaultFormatter(info: LogEntry): FormattedLogMessage {
    const { timestamp, level, message, ...metadata } = info;

    return {
      timestamp: timestamp || new Date().toISOString(),
      level,
      message,
      ...metadata,
    };
  }

  /**
   * Send message to Kafka
   */
  private async sendToKafka(info: LogEntry): Promise<void> {
    const messageValue = this.messageFormatter(info);

    const message: Message = {
      value: JSON.stringify(messageValue),
    };

    if (this.keyField && info[this.keyField]) {
      message.key = String(info[this.keyField]);
    }

    const record: ProducerRecord = {
      topic: this.topic,
      messages: [message],
    };

    await this.producer.send(record);
  }

  /**
   * Log method - hands the log off to Kafka (or the queue) without blocking winston
   */
  log(info: LogEntry, callback: () => void): void {
    setImmediate(() => {
      this.emit('logged', info);
    });

    if (callback) {
      callback();
    }

    if (this.closing) return;

    if (!this.connected || this.flushing) {
      this.enqueue(info);
      return;
    }

    this.sendToKafka(info).catch((error) => this.handleSendError(info, error));
  }

  /**
   * Close the Kafka producer connection
   */
  async close(): Promise<void> {
    this.closing = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const wasConnected = this.connected;
    this.connected = false;

    try {
      await this.producer.disconnect();
    } catch (error) {
      this.warn(error);
    }

    if (wasConnected) {
      this.emit('disconnected');
    }
  }

  /**
   * Check if transport is connected to Kafka
   */
  isConnected(): boolean {
    return this.connected;
  }
}

function isConnectionError(error: unknown): boolean {
  let current: any = error;

  for (let depth = 0; current && depth < 5; depth++) {
    if (CONNECTION_ERRORS.has(current.name)) return true;
    current = current.originalError || current.cause;
  }

  return false;
}

export default KafkaTransport;
