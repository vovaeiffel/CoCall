// src/protocol.ts
// ============================================================
// Типы сообщений сигналинга.
// Клиент и сервер общаются JSON-объектами, у каждого есть поле `type`.
// ============================================================

/** Уникальный идентификатор клиента (генерируется на клиенте при старте) */
export type ClientId = string;

/** Сообщение: регистрация (после подключения клиент представляется) */
export interface MsgRegister {
    type: 'register';
    clientId: ClientId;
    username: string;
}

/** Сообщение: клиент создаёт комнату и присылает SDP-offer'ы для гостей (пока пусто) */
export interface MsgCreateRoom {
    type: 'create-room';
    roomName: string;
    /** Необязательный пароль комнаты */
    password?: string;
    /** Ключ создания комнат (нужен, только если его задали на сервере) */
    createKey?: string;
    /** Переписка прежней комнаты (при переезде комнаты на нового хоста) */
    history?: ChatMessage[];
}

/** Сообщение: гость хочет войти в комнату */
export interface MsgJoinRoom {
    type: 'join-room';
    roomName: string;
    /** Пароль, если комната им защищена */
    password?: string;
}

/** Сигналинг: offer от хоста конкретному гостю */
export interface MsgOffer {
    type: 'offer';
    to: ClientId;          // кому адресован (clientId)
    from: ClientId;        // от кого
    sdp: RTCSessionDescriptionInit;
}

/** Сигналинг: answer от гостя хосту */
export interface MsgAnswer {
    type: 'answer';
    to: ClientId;
    from: ClientId;
    sdp: RTCSessionDescriptionInit;
}

/** Сигналинг: ICE-кандидат (в любую сторону) */
export interface MsgIce {
    type: 'ice-candidate';
    to: ClientId;
    from: ClientId;
    candidate: RTCIceCandidateInit;
}

/** Сервер → клиент: список комнат */
export interface MsgRoomList {
    type: 'room-list';
    rooms: Array<{
        name: string;
        host: string;
        /** Сколько гостей (не считая хоста) сейчас в комнате */
        guestCount: number;
        hasPassword: boolean;
        /** Всего людей в комнате (с хостом, если он сейчас в ней) */
        memberCount?: number;
        /** Хост сейчас в комнате (false — вышел, но комната открыта) */
        hostPresent?: boolean;
    }>;
}

/** Хост → сервер: выйти из голосовой комнаты, но оставить её открытой */
export interface MsgLeaveRoom {
    type: 'leave-room';
}

/** Сервер → клиент: список участников комнаты (обновление) */
export interface MsgParticipants {
    type: 'participants';
    roomName: string;
    participants: Array<{ clientId: ClientId; username: string; isHost: boolean; avatar?: string }>;
}

/** Сервер → хост: новый гость вошёл в комнату, пора создать для него peer */
export interface MsgGuestJoined {
    type: 'guest-joined';
    clientId: ClientId;
    username: string;
}

/** Сервер → гость: хост ушёл, комната закрыта */
export interface MsgRoomClosed {
    type: 'room-closed';
    roomName: string;
}

/** Сервер → гость: вас выгнали */
export interface MsgKicked {
    type: 'kicked';
    reason: string;
}

/** Сервер → хост: гость отключился (закрыть его peer) */
export interface MsgGuestLeft {
    type: 'guest-left';
    clientId: ClientId;
}

/** Хост → сервер: выгнать участника */
export interface MsgKickRequest {
    type: 'kick';
    targetClientId: ClientId;
}

/** Клиент → сервер → остальные участники: состояние речи («говорит / молчит») */
export interface MsgSpeaking {
    type: 'speaking';
    from: ClientId;
    speaking: boolean;
}

/** Клиент → сервер: мой аватар (маленькая картинка) или null — убрать */
export interface MsgSetAvatar {
    type: 'set-avatar';
    avatar: string | null;
}

/** Сообщение чата комнаты */
export interface ChatMessage {
    id: string;
    from: ClientId;
    username: string;
    text: string;
    /** Картинка в виде data:-адреса (png / jpeg / webp / gif) */
    image?: string;
    /** Картинка была, но её удалили из истории (старая) */
    imageExpired?: boolean;
    /** Файл, который отправитель предлагает скачать (id файла = id сообщения) */
    file?: ChatFile;
    /** Время отправки (мс, по часам сервера) */
    ts: number;
}

/** Описание файла в чате */
export interface ChatFile {
    name: string;
    size: number;
}

/** Получатель → сервер → владелец файла: хочу скачать */
export interface MsgFileRequest {
    type: 'file-request';
    to: ClientId;
    fileId: string;
    from?: ClientId;
}

/** Владелец → сервер → получатель: очередная порция файла (base64) */
export interface MsgFileChunk {
    type: 'file-chunk';
    to: ClientId;
    fileId: string;
    seq: number;
    data: string;
    last: boolean;
    from?: ClientId;
}

/** Получатель → сервер → владелец: порция принята, присылай следующую */
export interface MsgFileAck {
    type: 'file-ack';
    to: ClientId;
    fileId: string;
    seq: number;
    from?: ClientId;
}

/** Любая сторона: прервать передачу */
export interface MsgFileCancel {
    type: 'file-cancel';
    to: ClientId;
    fileId: string;
    reason?: string;
    from?: ClientId;
}

/** Клиент → сервер: отправить сообщение в чат */
export interface MsgChatSend {
    type: 'chat-send';
    text: string;
    image?: string;
    file?: ChatFile;
}

/** Сервер → все в комнате: новое сообщение чата */
export interface MsgChat {
    type: 'chat';
    message: ChatMessage;
}

/** Сервер → вошедшему: последние сообщения чата (чтобы не терять переписку) */
export interface MsgChatHistory {
    type: 'chat-history';
    messages: ChatMessage[];
}

/** Сервер → клиент: настройки сети (например, адрес TURN-сервера для передачи звука в сложных сетях) */
export interface MsgIceConfig {
    type: 'ice-config';
    iceServers: RTCIceServer[];
}

/** Качество трансляции экрана (высота картинки) */
export type ScreenQuality = '1080' | '720' | '480';

/** Клиент → сервер: начать показ экрана (или сменить качество, если уже показываем) */
export interface MsgScreenStart {
    type: 'screen-start';
    quality: ScreenQuality;
}

/** Клиент → сервер: закончить показ экрана */
export interface MsgScreenStop {
    type: 'screen-stop';
}

/** Сервер → все в комнате: кто сейчас показывает экран */
export interface MsgScreenShare {
    type: 'screen-share';
    sharing: boolean;
    from: ClientId;
    username: string;
    quality?: ScreenQuality;
}

/** Клиент → сервер: начал / закончил смотреть чужую трансляцию экрана */
export interface MsgScreenWatch {
    type: 'screen-watch';
    watching: boolean;
}

/** Сервер → все: кто сейчас смотрит трансляцию (видео уходит только им) */
export interface MsgScreenViewers {
    type: 'screen-viewers';
    viewers: ClientId[];
}

/** Сервер → клиент: показ экрана не разрешён (например, уже кто-то показывает) */
export interface MsgScreenDenied {
    type: 'screen-denied';
    message: string;
}

/** Клиент → сервер: включил / выключил веб-камеру */
export interface MsgCameraSet {
    type: 'camera-set';
    on: boolean;
}

/** Сервер → все: у кого сейчас включена камера */
export interface MsgCameras {
    type: 'cameras';
    ids: ClientId[];
}

/** Сервер → клиент: камеру включить нельзя (достигнут предел) */
export interface MsgCameraDenied {
    type: 'camera-denied';
    message: string;
}

/** Сервер → участникам: запасные хосты по порядку входа (адрес — как его видит сервер) */
export interface MsgBackup {
    type: 'backup';
    successors: Array<{ clientId: ClientId; username: string; address: string }>;
}

/** Сервер → клиентам: «я жив» (раз в несколько секунд) */
export interface MsgPing {
    type: 'ping';
}

/** Сервер → клиент: любая ошибка */
export interface MsgError {
    type: 'error';
    message: string;
}

/** Объединение всех типов для удобства */
export type SignalingMessage =
    | MsgRegister
    | MsgCreateRoom
    | MsgJoinRoom
    | MsgOffer
    | MsgAnswer
    | MsgIce
    | MsgRoomList
    | MsgLeaveRoom
    | MsgParticipants
    | MsgGuestJoined
    | MsgRoomClosed
    | MsgKicked
    | MsgGuestLeft
    | MsgKickRequest
    | MsgSpeaking
    | MsgIceConfig
    | MsgChatSend
    | MsgChat
    | MsgChatHistory
    | MsgSetAvatar
    | MsgFileRequest
    | MsgFileChunk
    | MsgFileAck
    | MsgFileCancel
    | MsgScreenStart
    | MsgScreenStop
    | MsgScreenShare
    | MsgScreenWatch
    | MsgScreenViewers
    | MsgScreenDenied
    | MsgCameraSet
    | MsgCameras
    | MsgCameraDenied
    | MsgBackup
    | MsgPing
    | MsgError;