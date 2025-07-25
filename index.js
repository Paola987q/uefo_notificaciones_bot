require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cron = require('node-cron');

// Parsear y preparar credenciales Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n').trim();

// Inicializar Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Inicializar bot Telegram
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

console.log('✅ Bot iniciado y escuchando...');

// Función para validar horario (6AM a 10PM)
function esHoraPermitida() {
  const hora = new Date().getHours();
  return hora >= 6 && hora < 22;
}

// Función para enviar notificación a estudiantes y padres
async function enviarNotificacion({ titulo, descripcion, fechaEntrega, grado, paralelo, asignaturaNombre, estudiantes }) {
  const mensajeBase = `📌 *Nueva tarea de ${asignaturaNombre}* 📌\nGrado: ${grado}\nParalelo: ${paralelo}\n\n*${titulo}*\n${descripcion}\n\n📅 Fecha de entrega: ${fechaEntrega}`;

  for (const est of estudiantes) {
    if (est.chatIdTelegram) {
      await bot.sendMessage(est.chatIdTelegram, mensajeBase, { parse_mode: 'Markdown' });
    }
    if (est.idPadre) {
      const padreDoc = await db.collection('Padres').doc(est.idPadre).get();
      if (padreDoc.exists && padreDoc.data().chatIdTelegram) {
        await bot.sendMessage(padreDoc.data().chatIdTelegram, `📌 *Tarea para tu hijo(a)* 📌\n${mensajeBase}`, { parse_mode: 'Markdown' });
      }
    }
  }
}

// Comando para registrar estudiante con /start <cedula>
bot.onText(/\/start (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cedula = match[1].trim();

  try {
    const estudiantesRef = db.collection('Estudiantes');
    const query = await estudiantesRef.where('cedula', '==', cedula).get();

    if (query.empty) {
      await bot.sendMessage(chatId, 'No se encontró ningún estudiante con esa cédula.');
      return;
    }

    query.forEach(doc => {
      doc.ref.update({ chatIdTelegram: chatId });
      bot.sendMessage(chatId, '✅ Tu Telegram ha sido vinculado exitosamente a tu cuenta de estudiante.');
    });
  } catch (error) {
    console.error('Error vinculando estudiante:', error);
    await bot.sendMessage(chatId, '❌ Ocurrió un error, inténtalo más tarde.');
  }
});

// Comando para registrar padre con /startpadre <cedula>
bot.onText(/\/startpadre (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cedula = match[1].trim();

  try {
    const padresRef = db.collection('Padres');
    const query = await padresRef.where('cedula', '==', cedula).get();

    if (query.empty) {
      await bot.sendMessage(chatId, 'No se encontró ningún padre con esa cédula.');
      return;
    }

    query.forEach(doc => {
      doc.ref.update({ chatIdTelegram: chatId });
      bot.sendMessage(chatId, '✅ Tu Telegram ha sido vinculado exitosamente a tu cuenta de padre.');
    });
  } catch (error) {
    console.error('Error vinculando padre:', error);
    await bot.sendMessage(chatId, '❌ Ocurrió un error, inténtalo más tarde.');
  }
});

// Escuchar nuevas tareas en las subcolecciones "Tareas" (collectionGroup)
const tareasRef = db.collectionGroup('Tareas');

tareasRef.onSnapshot(snapshot => {
  snapshot.docChanges().forEach(async change => {
    if (change.type === 'added') {
      const tarea = change.doc.data();

      const cursoDocRef = change.doc.ref.parent.parent;
      const cursoDoc = await cursoDocRef.get();
      const cursoData = cursoDoc.exists ? cursoDoc.data() : {};

      const grado = cursoData.grado || 'Desconocido';
      const paralelo = cursoData.paralelo || 'Desconocido';
      const asignaturaNombre = cursoData.asignaturaNombre || 'Asignatura';

      // Obtener estudiantes del curso y paralelo
      const estudiantesSnap = await db.collection('Estudiantes')
        .where('cursoId', '==', cursoDocRef.id)
        .where('paralelo', '==', paralelo)
        .get();

      const estudiantes = estudiantesSnap.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));

      const dataNotificacion = {
        titulo: tarea.titulo || '',
        descripcion: tarea.descripcion || '',
        fechaEntrega: tarea.fechaEntrega || '',
        grado,
        paralelo,
        asignaturaNombre,
        estudiantes,
      };

      if (esHoraPermitida()) {
        await enviarNotificacion(dataNotificacion);
      } else {
        // Guardar para notificar a las 6 AM
        await db.collection('NotificacionesPendientes').add(dataNotificacion);
        console.log('⏰ Notificación diferida para las 6AM');
      }
    }
  });
});

// Cron para enviar notificaciones pendientes a las 6AM cada día
cron.schedule('0 6 * * *', async () => {
  console.log('⏰ Ejecutando notificaciones pendientes (6AM)...');
  const snap = await db.collection('NotificacionesPendientes').get();
  for (const doc of snap.docs) {
    const data = doc.data();
    await enviarNotificacion(data);
    await doc.ref.delete();
  }
});
