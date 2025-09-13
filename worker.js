/**
 * @author: Assistant
 * @create_date: 2025-01-07
 * @description: OpenAI DALL-E compatible API for Cloudflare Worker AI image generation
 */

// 支持的图像生成模型配置
const SUPPORTED_MODELS = [
  {
    id: "stable-diffusion-xl", 
    object: "model",
    created: 1677610602,
    owned_by: "cloudflare",
    cf_model: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    max_size: "1024x1024", 
    supports_prompt_only: true
  },
  {
    id: "flux-1-schnell",
    object: "model",
    created: 1677610602,
    owned_by: "cloudflare",
    cf_model: "@cf/black-forest-labs/flux-1-schnell",
    max_size: "1024x1024",
    supports_prompt_only: true
  },
  {
    id: "dreamshaper-8-lcm",
    object: "model",
    created: 1677610602,
    owned_by: "cloudflare", 
    cf_model: "@cf/lykon/dreamshaper-8-lcm",
    max_size: "1024x1024",
    supports_prompt_only: true
  }
];

// API密钥配置（可选）
const API_KEYS = [
  // "Test"
];

// 生成唯一ID
function generateId() {
  return 'img-' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// 字节转Base64
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

// 限制数值范围
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// 标准化尺寸（64的倍数）
function sanitizeDimension(val, def = 1024) {
  let v = typeof val === 'number' ? val : def;
  v = clamp(v, 256, 2048);
  v = Math.round(v / 64) * 64;
  return v;
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // API密钥验证（如果配置了）
      if (API_KEYS.length > 0) {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response(JSON.stringify({
            error: {
              message: "You didn't provide an API key.",
              type: "invalid_request_error",
              param: null,
              code: null
            }
          }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const apiKey = authHeader.substring(7);
        if (!API_KEYS.includes(apiKey)) {
          return new Response(JSON.stringify({
            error: {
              message: "Incorrect API key provided.",
              type: "invalid_request_error", 
              param: null,
              code: "invalid_api_key"
            }
          }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }

      // 路由处理
      if (path === '/v1/models' && request.method === 'GET') {
        // 返回支持的模型列表
        return new Response(JSON.stringify({
          object: "list",
          data: SUPPORTED_MODELS.map(model => ({
            id: model.id,
            object: model.object,
            created: model.created,
            owned_by: model.owned_by
          }))
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } else if (path === '/v1/images/generations' && request.method === 'POST') {
        // 处理图像生成请求
        const requestData = await request.json();
        
        // 验证必需参数
        if (!requestData.prompt || typeof requestData.prompt !== 'string') {
          return new Response(JSON.stringify({
            error: {
              message: "Missing or invalid 'prompt' parameter",
              type: "invalid_request_error",
              param: "prompt",
              code: null
            }
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // 获取模型配置
        const modelId = requestData.model || "dall-e-3";
        const model = SUPPORTED_MODELS.find(m => m.id === modelId);
        if (!model) {
          return new Response(JSON.stringify({
            error: {
              message: `Model '${modelId}' not found`,
              type: "invalid_request_error",
              param: "model", 
              code: "model_not_found"
            }
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        try {
          // 解析参数
          const n = clamp(parseInt(requestData.n) || 1, 1, 4); // 生成图像数量
          const size = requestData.size || "1024x1024";
          const [width, height] = size.split('x').map(s => sanitizeDimension(parseInt(s)));
          const responseFormat = requestData.response_format || "url"; // "url" 或 "b64_json"
          
          // 构建Worker AI输入参数
          let inputs = {};
          const cfModel = model.cf_model;
          
          if (cfModel === "@cf/black-forest-labs/flux-1-schnell") {
            // FLUX模型参数
            inputs = {
              prompt: requestData.prompt,
              steps: clamp(parseInt(requestData.steps) || 6, 4, 8)
            };
          } else {
            // 其他模型的标准参数
            inputs = {
              prompt: requestData.prompt,
              negative_prompt: requestData.negative_prompt || '',
              height: height,
              width: width,
              num_steps: clamp(parseInt(requestData.num_steps) || 20, 1, 50),
              strength: clamp(parseFloat(requestData.strength) || 0.8, 0.0, 1.0),
              guidance: clamp(parseFloat(requestData.guidance) || 7.5, 0.0, 30.0),
              seed: parseInt(requestData.seed) || Math.floor(Math.random() * 1000000)
            };
          }

          console.log(`Generating ${n} image(s) with ${cfModel}`);

          // 生成图像
          const results = [];
          for (let i = 0; i < n; i++) {
            const localInputs = { ...inputs };
            if (localInputs.seed) {
              localInputs.seed = localInputs.seed + i; // 每张图使用不同的seed
            }

            const response = await env.AI.run(cfModel, localInputs);
            
            let imageData;
            if (cfModel === "@cf/black-forest-labs/flux-1-schnell") {
              // FLUX模型返回JSON格式
              const jsonResponse = typeof response === 'object' ? response : JSON.parse(response);
              if (!jsonResponse.image) {
                throw new Error('Invalid response from FLUX model');
              }
              imageData = jsonResponse.image; // 已经是base64格式
            } else {
              // 其他模型返回二进制数据
              let bytes;
              if (response instanceof Uint8Array) {
                bytes = response;
              } else if (response && typeof response === 'object' && typeof response.byteLength === 'number') {
                bytes = new Uint8Array(response);
              } else {
                bytes = new Uint8Array(await new Response(response).arrayBuffer());
              }
              imageData = bytesToBase64(bytes);
            }

            // 根据响应格式处理
            if (responseFormat === "b64_json") {
              results.push({
                b64_json: imageData
              });
            } else {
              // 返回data URL格式
              results.push({
                url: `data:image/png;base64,${imageData}`
              });
            }
          }

          // 构建OpenAI兼容的响应
          const response = {
            created: Math.floor(Date.now() / 1000),
            data: results
          };

          return new Response(JSON.stringify(response), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });

        } catch (aiError) {
          console.error('AI Error:', aiError);
          return new Response(JSON.stringify({
            error: {
              message: "Image generation failed: " + (aiError.message || "Unknown error"),
              type: "server_error",
              param: null,
              code: "ai_service_error"
            }
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

      } else if (path === '/v1/images/edits' && request.method === 'POST') {
        // 图像编辑功能（需要上传图像）
        return new Response(JSON.stringify({
          error: {
            message: "Image editing endpoint not implemented yet",
            type: "not_implemented_error",
            param: null,
            code: "not_implemented"
          }
        }), {
          status: 501,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } else if (path === '/v1/images/variations' && request.method === 'POST') {
        // 图像变体功能
        return new Response(JSON.stringify({
          error: {
            message: "Image variations endpoint not implemented yet", 
            type: "not_implemented_error",
            param: null,
            code: "not_implemented"
          }
        }), {
          status: 501,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } else if (path === '/') {
        // 根路径返回API信息
        return new Response(JSON.stringify({
          message: "Cloudflare Worker AI - OpenAI Compatible Image Generation API",
          version: "1.0.0",
          endpoints: {
            models: "GET /v1/models",
            generate: "POST /v1/images/generations"
          },
          supported_models: SUPPORTED_MODELS.map(m => m.id)
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } else {
        return new Response(JSON.stringify({
          error: {
            message: "Not Found",
            type: "invalid_request_error",
            param: null,
            code: "not_found"
          }
        }), { 
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({
        error: {
          message: "Internal server error: " + error.message,
          type: "server_error",
          param: null,
          code: "internal_error"
        }
      }), { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
