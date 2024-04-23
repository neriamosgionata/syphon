import Env from "@ioc:Adonis/Core/Env";
import axios, {AxiosInstance} from "axios";
import Helper from "@ioc:Providers/Helper";
import Log from "@ioc:Providers/Logger";
import {trim} from "lodash";

export interface ProfilerContract {
  askAnything(prompt: string): Promise<ProfilerChatResponse | null>;
}

export interface ProfilerChatResponse {
  data: ProfilerChatData[],
  is_generating: boolean,
  duration: number,
  average_duration: number,
}

export interface ProfilerChatData {
  response: string,
  sources?: string,
  save_dict?: ProfilerChatSaveDict,
  llm_answers?: any,
}

export interface ProfilerChatSaveDict {
  which_api?: string,
  valid_key?: string,
  h20gpt_key?: string,
  prompt?: string
  output?: string
  base_model?: string
  save_dir?: string
  where_from?: string
  extra_dict: ProfilerChatExtraDict
  error?: string,
  extra?: string
}

export interface ProfilerChatExtraDict {
  num_beams?: number,
  do_sample?: boolean,
  repetition_penalty?: number,
  num_return_sequences?: number,
  renormalize_logits?: boolean,
  remove_invalid_values?: boolean,
  use_cache?: boolean,
  eos_token_id?: number,
  bos_token_id?: number,
  num_prompt_tokens?: number,
  t_generate?: number,
  ntokens?: number,
  tokens_persecond?: number
}

export default class Profiler implements ProfilerContract {
  private axios: AxiosInstance;

  constructor() {
    this.axios = axios.create({
      baseURL: trim(Env.get('H20_URL'), "/") + "/api",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      }
    });
  }

  async askAnything(prompt: string): Promise<ProfilerChatResponse | null> {
    const no_chat_api = "/submit_nochat_plain_api";

    try {
      const res = await this.axios.post(no_chat_api, {
        data: [{instruction_nochat: prompt}]
      })

      res.data.data = res.data.data.map((d: string) => {
        return JSON.parse(Helper.pythonSerializedToJson(d));
      });

      return res.data as ProfilerChatResponse;
    } catch (e) {
      await Log.error(e.message, e.stack);
      return null;
    }
  }

  async uploadFile(file: Buffer, filename: string): Promise<string | null> {
    const upload_api = "/upload_file";

    try {
      const res = await this.axios.post(
        upload_api,
        {
          file: file.toString('base64'),
          filename: filename
        }
      )

      return res.data as string;
    } catch (e) {
      await Log.error(e.message, e.stack);
      return null;
    }
  }
}
