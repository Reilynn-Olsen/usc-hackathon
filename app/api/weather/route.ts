const latitude = 33.74;
const longitude = -118.27;

export async function GET() {
  const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
  const marineUrl = new URL("https://marine-api.open-meteo.com/v1/marine");

  for (const url of [weatherUrl, marineUrl]) {
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("timezone", "America/Los_Angeles");
    url.searchParams.set("forecast_days", "2");
  }

  weatherUrl.searchParams.set("hourly", "temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility,weather_code");
  marineUrl.searchParams.set("hourly", "wave_height,wave_direction,wave_period,wind_wave_height,swell_wave_height,swell_wave_period,ocean_current_velocity,ocean_current_direction");

  try {
    const [weatherResponse, marineResponse] = await Promise.all([
      fetch(weatherUrl),
      fetch(marineUrl),
    ]);

    if (!weatherResponse.ok || !marineResponse.ok) {
      return Response.json({ error: "An Open-Meteo service returned an error." }, { status: 502 });
    }

    const [weather, marine] = await Promise.all([
      weatherResponse.json(),
      marineResponse.json(),
    ]);

    return Response.json({
      source: "Open-Meteo",
      location: { name: "Port of Los Angeles", latitude, longitude },
      fetchedAt: new Date().toISOString(),
      weather,
      marine,
    });
  } catch {
    return Response.json({ error: "Could not reach Open-Meteo." }, { status: 502 });
  }
}
