/**
 * ==============================================================================
 * ULTRA ROTINA · TELEGRAM MINI APP (WEBAPP)
 * ==============================================================================
 * Integração bidirecional com Telegram Mini App (Cockpit PWA):
 * - Configuração de Chat Menu Button com WebApp em tela cheia.
 * - Processamento de web_app_data enviados pelo Cockpit para o chat.
 * ==============================================================================
 */

/**
 * Configura o botão fixo de menu do chat do Telegram (ao lado do teclado)
 * para abrir diretamente o Cockpit PWA em tela cheia (Mini App).
 * @param {string|number} [chatId] - Chat ID específico ou todos os chats se omitido.
 * @returns {boolean} Sucesso da chamada.
 */
function configurarMenuButtonTelegram(chatId) {
  var token = (typeof ConfigService !== "undefined" && ConfigService.get)
    ? ConfigService.get("TELEGRAM_BOT_TOKEN")
    : null;
  if (!token) return false;

  var urlCockpit = (typeof obterUrlCockpit === "function")
    ? obterUrlCockpit(chatId)
    : "https://wagmmss.github.io/cockpit/";

  var payload = {
    menu_button: {
      type: "web_app",
      text: "🩺 Cockpit",
      web_app: {
        url: urlCockpit
      }
    }
  };
  if (chatId) {
    payload.chat_id = chatId;
  }

  var url = "https://api.telegram.org/bot" + token + "/setChatMenuButton";
  if (typeof executarPostTelegram === "function") {
    return executarPostTelegram(url, payload);
  }

  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  try {
    var res = UrlFetchApp.fetch(url, options);
    return res.getResponseCode() === 200;
  } catch (err) {
    return false;
  }
}

/**
 * Ponto de entrada oficial para processamento de mensagens com web_app_data
 * originadas do Cockpit PWA (quando o médico clica em 'Enviar para o Chat').
 * @param {Object} message - Objeto message do Telegram com propriedade web_app_data.
 * @returns {boolean}
 */
function processarWebAppData(message) {
  if (!message || !message.web_app_data || !message.chat) return false;
  var rawData = message.web_app_data.data || "{}";
  var chatId = message.chat.id;

  var payload;
  try {
    payload = JSON.parse(rawData);
  } catch (err) {
    var txtSimples = "📱 <b>DADOS DO COCKPIT RECEBIDOS</b>\n\n" + String(rawData).slice(0, 1000);
    return (typeof enviarMensagemParaChat === "function") ? enviarMensagemParaChat(chatId, txtSimples) : false;
  }

  var titulo = payload.titulo || "Sincronização Cockpit PWA";
  var conteudo = payload.conteudo || payload.texto || payload.dados || "";

  var msgFormatada = "📱 <b>" + String(titulo).toUpperCase() + "</b>\n" +
    "───────────────────────────\n" +
    "Origem: <i>Cockpit Mini App</i>\n\n" +
    (typeof conteudo === "string" ? conteudo : JSON.stringify(conteudo, null, 2)) + "\n\n" +
    "✅ <i>Dados integrados com sucesso à sua sessão clínica.</i>";

  var kb = {
    inline_keyboard: [
      [
        { text: "📋 Copiar para Prontuário", callback_data: "ux:soap:copiar" },
        { text: "📱 Reabrir Cockpit", web_app: { url: (typeof obterUrlCockpit === "function") ? obterUrlCockpit(chatId) : "" } }
      ]
    ]
  };

  if (typeof enviarMensagemComTecladoParaChat === "function") {
    return enviarMensagemComTecladoParaChat(chatId, msgFormatada, kb);
  }
  if (typeof enviarMensagemParaChat === "function") {
    return enviarMensagemParaChat(chatId, msgFormatada);
  }
  return false;
}
