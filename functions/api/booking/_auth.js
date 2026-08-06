// Helper de autenticación dedicada para solicitudes de escritura del Chatbot Bridge (/api/booking/*).

export function validateChatbotSecret(request, env) {
  const secret = env.CHATBOT_SECRET;
  if (!secret) {
    // Si no está configurado CHATBOT_SECRET en variables de entorno, permite acceso local
    return true;
  }

  const headerSecret = request.headers.get("x-chatbot-secret");
  const authHeader = request.headers.get("authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();

  if (headerSecret === secret || bearerToken === secret) {
    return true;
  }

  return false;
}
