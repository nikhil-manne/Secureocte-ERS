import React, { useEffect, useRef, useState } from "react";
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  FlatList,
  Keyboard,
} from "react-native";

import MapView, { Marker } from "react-native-maps";
import * as Location from "expo-location";
import Constants from "expo-constants";
import { apiFetch, apiMultipart, AuthError, BASE_URL } from "./api";
import { AuthContext } from "./AuthContext";

const API_KEY = Constants.expoConfig.extra.googleApiKey;

export default function CabDestinationMapScreen({ onConfirm, onBack }) {
  const mapRef = useRef(null);

  const [region, setRegion] = useState(null);
  const [tempDestination, setTempDestination] = useState(null);

  const [search, setSearch] = useState("");
  const [predictions, setPredictions] = useState([]);

  // Load current location
  useEffect(() => {
    (async () => {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;

      const loc = await Location.getCurrentPositionAsync({});
      setRegion({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      });
    })();
  }, []);

  // Autocomplete
  const fetchPredictions = async (text) => {
    setSearch(text);

    if (text.length < 3) {
      setPredictions([]);
      return;
    }

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
      text
    )}&key=${API_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "OK") {
      setPredictions(data.predictions);
    }
  };

  // Select prediction
  const selectPlace = async (place) => {
    Keyboard.dismiss();
    setPredictions([]);

    const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=geometry,formatted_address&key=${API_KEY}`;

    const res = await fetch(detailsUrl);
    const data = await res.json();

    if (data.status === "OK") {
      const loc = data.result.geometry.location;

      const coords = {
        latitude: loc.lat,
        longitude: loc.lng,
        address: place.description,
      };

      setTempDestination(coords);

      mapRef.current?.animateToRegion({
        latitude: coords.latitude,
        longitude: coords.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      });
    }
  };

  return (
    <View style={{ flex: 1 }}>
      {region && (
        <MapView
          ref={mapRef}
          style={{ flex: 1 }}
          initialRegion={region}
          showsUserLocation={true}
          onPress={(e) =>
            setTempDestination({
              latitude: e.nativeEvent.coordinate.latitude,
              longitude: e.nativeEvent.coordinate.longitude,
              address: "Custom Location",
            })
          }
        >
          {tempDestination && <Marker coordinate={tempDestination} />}
        </MapView>
      )}

      {/* Search */}
      <View style={styles.searchBox}>
        <TextInput
          placeholder="Search destination..."
          value={search}
          onChangeText={fetchPredictions}
          style={styles.input}
        />

        {predictions.length > 0 && (
          <FlatList
            data={predictions}
            keyExtractor={(item) => item.place_id}
            style={styles.list}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.row}
                onPress={() => selectPlace(item)}
              >
                <Text>{item.description}</Text>
              </TouchableOpacity>
            )}
          />
        )}
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity style={styles.backBtn} onPress={onBack}>
          <Text style={styles.btnText}>← Back</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.confirmBtn}
          disabled={!tempDestination}
          onPress={() => onConfirm(tempDestination)}
        >
          <Text style={styles.btnText}>Confirm Destination</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  searchBox: {
    position: "absolute",
    top: 40,
    left: 15,
    right: 15,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 10,
  },
  input: {
    padding: 10,
    fontSize: 16,
  },
  list: {
    maxHeight: 200,
  },
  row: {
    padding: 10,
    borderBottomWidth: 1,
    borderColor: "#eee",
  },
  controls: {
    position: "absolute",
    bottom: 25,
    left: 15,
    right: 15,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  backBtn: {
    backgroundColor: "#c0392b",
    padding: 14,
    borderRadius: 10,
    flex: 0.4,
    alignItems: "center",
  },
  confirmBtn: {
    backgroundColor: "#27ae60",
    padding: 14,
    borderRadius: 10,
    flex: 0.55,
    alignItems: "center",
  },
  btnText: { color: "#fff", fontWeight: "bold" },
});
