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
 * Updates and awareness wait behind the token too: a first frame of any kind
 * makes the hub count the room. A stale async token cannot open a later socket.
 */
export class PacedRoomProvider extends HocuspocusProvider {
  private ticket: Ticket | null = null;
  private tokenTicket: Ticket | null = null;
  private tokenSent = false;

  constructor(
    private readonly admission: RoomAdmission,
    configuration: ConstructorParameters<typeof HocuspocusProvider>[0],
  ) {
    super(configuration);
    this.on("authenticated", () => this.ticket?.finish());
    this.on("authenticationFailed", () => this.ticket?.finish());
    this.on("close", ({ event }: { event?: { reason?: string } }) => {
      // A replacement provider can receive the old provider's detach echo.
      // It is not this provider losing its socket or its admission.
      if (event?.reason !== "provider_initiated") this.cancel();
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
    this.tokenSent = false;
  }

  override async onOpen(event: Parameters<HocuspocusProvider["onOpen"]>[0]): Promise<void> {
    this.cancel();
    this.isAuthenticated = false;
    const ticket = this.admission.request();
    this.ticket = ticket;
    if (await ticket.ready && this.ticket === ticket && this.isAttached && this.socketOpen()) {
      this.emit("open", { event });
      await this.sendToken();
      if (this.ticket === ticket) this.startSync();
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
    if (this.tokenSent && this.socketOpen()) super.startSync();
  }

  override send(
    Message: Parameters<HocuspocusProvider["send"]>[0],
    args: Parameters<HocuspocusProvider["send"]>[1],
  ): void {
    if (!this.socketOpen()) return;
    if (this.tokenSent) {
      // An older onOpen continuation returns the empty sentinel after a flap.
      if (args.token === "") return;
      super.send(Message, args);
      return;
    }
    const type = new Message().type;
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
