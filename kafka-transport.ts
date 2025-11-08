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

  /** KafkaJS producer configuration */
  producerConfig?: ProducerConfig;

  /** Full KafkaJS client configuration (overrides brokers/clientId) */
  kafka?: KafkaConfig;

  /** Maximum messages to queue while disconnected (default: 1000) */
  maxQueueSize?: number;
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

/**
 * Queued log entry waiting to be sent
 */
interface QueuedLog {
  info: LogEntry;
  callback?: () => void;
}

/**
 * Custom Kafka Transport for Winston
 * Sends log messages to Apache Kafka topics with full TypeScript support
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
  private messageQueue: QueuedLog[] = [];
  private maxQueueSize: number;

  constructor(opts: KafkaTransportOptions = {}) {
    super(opts);

    this.kafkaConfig = opts.kafka || {
      clientId: opts.clientId || 'winston-kafka-logger',
      brokers: opts.brokers || ['localhost:9092'],
    };

    this.producerConfig = opts.producerConfig || {};

    this.topic = opts.topic || 'logs';
    this.keyField = opts.keyField || null;

    this.maxQueueSize = opts.maxQueueSize || 1000;

    this.messageFormatter = opts.messageFormatter || this.defaultFormatter.bind(this);

    this.kafka = new Kafka(this.kafkaConfig);
    this.producer = this.kafka.producer(this.producerConfig);

    this.connect();
  }

  /**
   * Connect to Kafka broker
   */
  private async connect(): Promise<void> {
    if (this.connecting || this.connected) return;

    this.connecting = true;

    try {
      await this.producer.connect();
      this.connected = true;
      this.connecting = false;
      this.emit('connected');

      await this.processQueue();
    } catch (error) {
      this.connecting = false;
      this.emit('error', error);
      setTimeout(() => this.connect(), 5000);
    }
  }

  /**
   * Process queued messages
   */
  private async processQueue(): Promise<void> {
    if (!this.connected || this.messageQueue.length === 0) return;

    const queue = [...this.messageQueue];
    this.messageQueue = [];

    for (const { info, callback } of queue) {
      try {
        await this.sendToKafka(info);
      } catch (error) {
        this.emit('error', error);
      }

      if (callback) {
        callback();
      }
    }
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
   * Log method - sends log to Kafka or queues if not connected
   */
  async log(info: LogEntry, callback: () => void): Promise<void> {
    setImmediate(() => {
      this.emit('logged', info);
    });

    if (!this.connected) {
      if (this.messageQueue.length < this.maxQueueSize) {
        this.messageQueue.push({ info, callback });
      } else {
        const error = new Error(`Message queue full (${this.maxQueueSize} messages). Dropping log.`);
        this.emit('warn', error);
        if (callback) {
          callback();
        }
      }
      return;
    }

    try {
      await this.sendToKafka(info);
    } catch (error) {
      this.emit('error', error);
    }

    if (callback) {
      callback();
    }
  }

  /**
   * Close the Kafka producer connection
   */
  async close(): Promise<void> {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
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

export default KafkaTransport;
