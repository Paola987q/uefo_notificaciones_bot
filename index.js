const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cron = require('node-cron');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const token = '8042832465:AAEm1uX86LrCqEWFp9FwA6r8IFam5A2onz8'; // Pon aquí tu token real
const bot = new TelegramBot(token, { polling: true });

console.log('Bot iniciado y escuchando...');

function esHoraPermitida() {
  const hora = new Date().getHours();
  return hora >= 6 && hora < 22; // entre 6AM y antes de 10PM
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

// Registrar chatIdTelegram para estudiantes con /start cédula
bot.onText(/\/start (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cedula = match[1].trim();

  try {
    const estudiantesRef = db.collection('Estudiantes');
    const query = await estudiantesRef.where('cedula', '==', cedula).get();

    if (query.empty) {
      bot.sendMessage(chatId, 'No se encontró ningún estudiante con esa cédula.');
      return;
    }

    query.forEach(doc => {
      doc.ref.update({ chatIdTelegram: chatId });
      bot.sendMessage(chatId, '✅ Tu Telegram ha sido vinculado exitosamente a tu cuenta.');
    });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Ocurrió un error, inténtalo más tarde.');
  }
});

// Registrar chatIdTelegram para padres con /startpadre cédula
bot.onText(/\/startpadre (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cedula = match[1].trim();

  try {
    const padresRef = db.collection('Padres');
    const query = await padresRef.where('cedula', '==', cedula).get();

    if (query.empty) {
      bot.sendMessage(chatId, 'No se encontró ningún padre con esa cédula.');
      return;
    }

    query.forEach(doc => {
      doc.ref.update({ chatIdTelegram: chatId });
      bot.sendMessage(chatId, '✅ Tu Telegram ha sido vinculado exitosamente a tu cuenta de padre.');
    });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Ocurrió un error, inténtalo más tarde.');
  }
});

// Escuchar tareas nuevas y manejar notificaciones inmediatas o diferidas
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
        timestamp: admin.firestore.Timestamp.now(),
      };

      if (esHoraPermitida()) {
        await enviarNotificacion(dataNotificacion);
      } else {
        await db.collection('NotificacionesPendientes').add(dataNotificacion);
        console.log('⏰ Notificación diferida para las 6AM');
      }
    }
  });
});

// Cron para enviar notificaciones pendientes a las 6AM todos los días
cron.schedule('0 6 * * *', async () => {
  console.log('⏰ Ejecutando notificaciones pendientes (6AM)...');
  const snap = await db.collection('NotificacionesPendientes').get();
  for (const doc of snap.docs) {
    const data = doc.data();
    await enviarNotificacion(data);
    await doc.ref.delete();
  }
});
