import {
  HocuspocusProvider,
  MessageType,
} from "@hocuspocus/provider";

// Stay below the hub's 100 pending rooms, including during socket reconnects.
const MAX_PENDING_ROOMS = 32;

interface Ticket {
  ready: Promise<boolean>;
  finish(): void;
}

/** Each slot lasts until authentication answers, or the room closes. */
export class RoomAdmission {
  private readonly active = new Set<Ticket>();
  private readonly waiting = new Map<Ticket, (granted: boolean) => void>();

  constructor(private readonly limit = MAX_PENDING_ROOMS) {}

  request(): Ticket {
    let resolve!: (granted: boolean) => void;
    const ready = new Promise<boolean>((done) => { resolve = done; });
    const ticket: Ticket = {
      ready,
      finish: () => {
        this.waiting.delete(ticket);
        this.active.delete(ticket);
        resolve(false);
        this.pump();
      },
    };
    this.waiting.set(ticket, resolve);
    this.pump();
    return ticket;
  }

  private pump(): void {
    for (const [ticket, resolve] of this.waiting) {
      if (this.active.size >= this.limit) break;
      this.waiting.delete(ticket);
      this.active.add(ticket);
      resolve(true);
    }
  }
}

/**
 * The provider's public token and send seams pace every attach and reconnect.
 * Only authentication and detach can precede the hub's room authentication.
 * A stale async token cannot open a later socket.
 */
export class PacedRoomProvider extends HocuspocusProvider {
  private ticket: Ticket | null = null;
  private tokenTicket: Ticket | null = null;
  private authenticatedTicket: Ticket | null = null;
  private tokenSent = false;

  constructor(
    private readonly admission: RoomAdmission,
    configuration: ConstructorParameters<typeof HocuspocusProvider>[0],
    private readonly canSync: () => boolean = () => true,
  ) {
    super(configuration);
    this.on("authenticated", () => this.ticket?.finish());
    this.on("authenticationFailed", () => this.ticket?.finish());
    this.on("close", ({ event }: { event?: { reason?: string } }) => {
      // A replacement provider can receive the old provider's detach echo.
      // It is not this provider losing its socket or its admission.
      if (event?.reason !== "provider_initiated") this.cancel();
      else this.isAuthenticated = this.hasAuthenticated;
    });
  }

  private socketOpen(): boolean {
    const socket = this.configuration.websocketProvider.webSocket;
    return socket !== null && socket.readyState === socket.OPEN;
  }

  private cancel(): void {
    this.ticket?.finish();
    this.ticket = null;
    this.tokenTicket = null;
    this.authenticatedTicket = null;
    this.tokenSent = false;
    this.isAuthenticated = false;
  }

  override async onOpen(event: Parameters<HocuspocusProvider["onOpen"]>[0]): Promise<void> {
    this.cancel();
    this.isAuthenticated = false;
    const ticket = this.admission.request();
    this.ticket = ticket;
    if (await ticket.ready && this.ticket === ticket && this.isAttached && this.socketOpen()) {
      this.emit("open", { event });
      await this.sendToken();
    } else {
      ticket.finish();
    }
  }

  override async getToken(): Promise<string | null> {
    const ticket = this.ticket;
    let token: string | null;
    try {
      token = await super.getToken();
    } catch (error) {
      if (ticket !== this.ticket || !this.socketOpen()) return "";
      throw error;
    }
    if (ticket === null || this.ticket !== ticket || !this.isAttached || !this.socketOpen()) {
      return "";
    }
    this.tokenTicket = ticket;
    return token;
  }

  override startSync(): void {
    if (this.hasAuthenticated && this.canSync()) super.startSync();
  }

  get hasAuthenticated(): boolean {
    return this.authenticatedTicket !== null && this.authenticatedTicket === this.ticket &&
      this.tokenSent && this.isAttached && this.socketOpen();
  }

  override authenticatedHandler(scope: string): void {
    if (this.hasAuthenticated) return;
    if (!this.tokenSent || this.ticket === null || !this.isAttached || !this.socketOpen()) return;
    this.authenticatedTicket = this.ticket;
    super.authenticatedHandler(scope);
    this.startSync();
  }

  override permissionDeniedHandler(reason: string): void {
    super.permissionDeniedHandler(reason);
    this.cancel();
  }

  override onMessage(event: MessageEvent): void {
    if (!this.isAttached || !this.socketOpen()) return;
    if (!this.hasAuthenticated) {
      // Read only the frame header. Payload decoding remains Hocuspocus's job.
      const bytes = new Uint8Array(event.data);
      let roomLength = 0;
      let offset = 0;
      for (; offset < 5 && offset < bytes.length; offset += 1) {
        const byte = bytes[offset];
        if (byte === undefined) return;
        roomLength += (byte & 0x7f) * 2 ** (offset * 7);
        if (byte < 0x80) break;
      }
      if (offset >= 5 || offset >= bytes.length) return;
      const type = bytes[offset + 1 + roomLength];
      if (type !== MessageType.Auth && type !== MessageType.CLOSE) return;
    }
    super.onMessage(event);
  }

  override send(
    Message: Parameters<HocuspocusProvider["send"]>[0],
    args: Parameters<HocuspocusProvider["send"]>[1],
  ): void {
    if (!this.socketOpen()) return;
    const type = new Message().type;
    // Sync replies have no type on their message wrapper; gate them too.
    if (!this.canSync() && type !== MessageType.Auth && type !== MessageType.CLOSE) return;
    if (this.hasAuthenticated) {
      // An older onOpen continuation returns the empty sentinel after a flap.
      if (args.token === "") return;
      super.send(Message, args);
      return;
    }
    if (type === MessageType.CLOSE) {
      super.send(Message, args);
    } else if (
      type === MessageType.Auth && args.token !== "" &&
      this.ticket !== null && this.tokenTicket === this.ticket
    ) {
      super.send(Message, args);
      this.tokenSent = true;
    }
  }

  override detach(): void {
    this.cancel();
    super.detach();
  }
}
