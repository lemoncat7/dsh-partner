export interface QrCodeData {
  qrcode?: string
  qrcode_img_content?: string
}

export interface QrCodeStatusData {
  status?: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
}

export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinRawMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface WeixinRawMessage {
  seq?: number
  from_user_id?: string
  context_token?: string
  message_id?: number | string
  msg_id?: number | string
  create_time_ms?: number
  message_type?: number
  item_list?: WeixinRawItem[]
}

export interface WeixinRawItem {
  type?: number
  text_item?: { text?: string }
  voice_item?: { text?: string }
  image_item?: {
    filename?: string
    content_type?: string
    aeskey?: string
    media?: WeixinCdnMedia
  }
  file_item?: {
    filename?: string
    file_name?: string
    content_type?: string
    len?: string
    media?: WeixinCdnMedia
  }
}

export interface WeixinCdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}
