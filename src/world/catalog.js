// Asset catalogue generated from the shipped pack by tools/build/build-catalog.mjs.
export const CATALOG = {
  "arcade": {
    "world": [
      {
        "id": "meadow",
        "label": "Meadow village",
        "description": "Open pastel meadow: painted grass, trees and a generated village",
        "interior": false,
        "decorations": [],
        "model": "assets/v2/arcade/arcade-ground.glb",
        "surface": "meadow",
        "preview": "assets/v2/arcade/arcade-lookdev-review.png"
      },
      {
        "id": "desert",
        "label": "Desert oasis",
        "description": "Sun-baked oasis town: plaster houses and domes, palms round the water, a striped market",
        "surface": "desert",
        "biome": "desert",
        "preview": "assets/v2/arcade/arcade-desert-review.png",
        "interior": false,
        "decorations": [],
        "model": "assets/v2/arcade/arcade-ground.glb"
      },
      {
        "id": "snow",
        "label": "Snow village",
        "description": "Cozy alpine village: log cabins and timber lodges under thick snow, a bell tower over the square, a frozen pond",
        "surface": "snow",
        "biome": "snow",
        "preview": "assets/v2/arcade/arcade-snow-review.png",
        "interior": false,
        "decorations": [],
        "model": "assets/v2/arcade/arcade-ground.glb"
      }
    ],
    "weapons": [
      {
        "id": "sidearm",
        "model": "assets/v2/arcade/arcade-slingshot.glb",
        "metres": 0.3037,
        "archetype": "pistol",
        "slot": 0,
        "label": "Slingshot",
        "overrides": {
          "shell": null,
          "muzzleFlashScale": 0.04,
          "muzzleFlashColor": 16773577,
          "lightIntensity": 0
        },
        "preview": "assets/v2/arcade/catalog/slingshot.png"
      },
      {
        "id": "assault",
        "model": "assets/v2/arcade/arcade-repeater.glb",
        "metres": 0.708,
        "archetype": "smgGun",
        "slot": 1,
        "label": "Repeating crossbow",
        "overrides": {
          "shell": null,
          "muzzleFlashScale": 0.04,
          "muzzleFlashColor": 16773577,
          "lightIntensity": 0
        },
        "preview": "assets/v2/arcade/catalog/repeater.png"
      },
      {
        "id": "shotgun",
        "model": "assets/v2/arcade/arcade-blunderbuss.glb",
        "metres": 1.046,
        "archetype": "shotgun",
        "slot": 2,
        "label": "Blunderbuss",
        "overrides": {
          "shell": null,
          "muzzleFlashColor": 16761466
        },
        "preview": "assets/v2/arcade/catalog/blunderbuss.png"
      },
      {
        "id": "marksman",
        "model": "assets/v2/arcade/arcade-arbalest.glb",
        "metres": 1.068,
        "archetype": "sniper",
        "slot": 3,
        "label": "Heavy crossbow",
        "overrides": {
          "shell": null,
          "muzzleFlashScale": 0.04,
          "muzzleFlashColor": 16773577,
          "lightIntensity": 0
        },
        "preview": "assets/v2/arcade/catalog/arbalest.png"
      },
      {
        "id": "launcher",
        "model": "assets/v2/arcade/arcade-cannon.glb",
        "metres": 0.666,
        "archetype": "rpg",
        "slot": 4,
        "label": "Mini cannon",
        "overrides": {
          "muzzleFlashColor": 16757596
        },
        "preview": "assets/v2/arcade/catalog/cannon.png"
      }
    ],
    "enemies": [
      {
        "id": "slime",
        "model": "assets/v2/arcade/arcade-creature-parts.glb",
        "metres": 1.2,
        "height": 1.2,
        "archetype": "runner",
        "animation": "rigid",
        "label": "Slime",
        "preview": "assets/v2/arcade/catalog/slime.png",
        "generator": {
          "family": "slime"
        },
        "radius": 0.55,
        "boss": false
      },
      {
        "id": "shroom",
        "model": "assets/v2/arcade/arcade-creature-parts.glb",
        "metres": 1.5,
        "height": 1.5,
        "archetype": "shambler",
        "animation": "rigid",
        "label": "Shroomling",
        "preview": "assets/v2/arcade/catalog/shroom.png",
        "generator": {
          "family": "shroom"
        },
        "radius": 0.5,
        "boss": false
      },
      {
        "id": "bee",
        "model": "assets/v2/arcade/arcade-creature-parts.glb",
        "metres": 1.4,
        "height": 1.4,
        "archetype": "brute",
        "animation": "rigid",
        "label": "Bumble bee",
        "preview": "assets/v2/arcade/catalog/bee.png",
        "generator": {
          "family": "bee"
        },
        "radius": 0.55,
        "hover": 0.45,
        "boss": false
      },
      {
        "id": "sprout",
        "model": "assets/v2/arcade/arcade-creature-parts.glb",
        "metres": 1.2,
        "height": 1.2,
        "archetype": "husk",
        "animation": "rigid",
        "label": "Sprout",
        "preview": "assets/v2/arcade/catalog/sprout.png",
        "generator": {
          "family": "sprout"
        },
        "radius": 0.45,
        "boss": false
      },
      {
        "id": "pebble",
        "model": "assets/v2/arcade/arcade-creature-parts.glb",
        "metres": 1.3,
        "height": 1.3,
        "archetype": "brute",
        "animation": "rigid",
        "label": "Pebble turtle",
        "preview": "assets/v2/arcade/catalog/pebble.png",
        "generator": {
          "family": "pebble"
        },
        "radius": 0.6,
        "boss": false
      },
      {
        "id": "batpuff",
        "model": "assets/v2/arcade/arcade-creature-parts.glb",
        "metres": 1.4,
        "height": 1.4,
        "archetype": "prowler",
        "animation": "rigid",
        "label": "Bat-puff",
        "preview": "assets/v2/arcade/catalog/batpuff.png",
        "generator": {
          "family": "batpuff"
        },
        "radius": 0.5,
        "hover": 0.55,
        "boss": false
      },
      {
        "id": "hornblob",
        "model": "assets/v2/arcade/arcade-creature-parts.glb",
        "metres": 1.35,
        "height": 1.35,
        "archetype": "shambler",
        "animation": "rigid",
        "label": "Horned blob",
        "preview": "assets/v2/arcade/catalog/hornblob.png",
        "generator": {
          "family": "hornblob"
        },
        "radius": 0.6,
        "boss": false
      },
      {
        "id": "acorn",
        "model": "assets/v2/arcade/arcade-creature-parts.glb",
        "metres": 1.25,
        "height": 1.25,
        "archetype": "husk",
        "animation": "rigid",
        "label": "Acorn",
        "preview": "assets/v2/arcade/catalog/acorn.png",
        "generator": {
          "family": "acorn"
        },
        "radius": 0.45,
        "boss": false
      },
      {
        "id": "spirit",
        "model": "assets/v2/arcade/arcade-creature-parts.glb",
        "metres": 1.7,
        "height": 1.7,
        "archetype": "lurker",
        "animation": "rigid",
        "label": "Forest spirit",
        "preview": "assets/v2/arcade/catalog/spirit.png",
        "generator": {
          "family": "spirit"
        },
        "radius": 0.45,
        "boss": false
      },
      {
        "id": "king",
        "model": "assets/v2/arcade/arcade-creature-parts.glb",
        "metres": 3,
        "height": 3,
        "archetype": "behemoth",
        "animation": "rigid",
        "label": "King slime",
        "preview": "assets/v2/arcade/catalog/king.png",
        "generator": {
          "family": "slime",
          "rank": "boss"
        },
        "radius": 1.15,
        "boss": true
      }
    ],
    "doors": [
      {
        "id": "woodGate",
        "label": "Village gate",
        "model": "assets/v2/arcade/arcade-gate.glb",
        "metres": 4.45,
        "role": "gate",
        "collision": "box",
        "density": 0.15,
        "preview": "assets/v2/arcade/catalog/gate.png"
      }
    ],
    "props": [
      {
        "id": "barrel",
        "model": "assets/v2/arcade/arcade-barrel.glb",
        "metres": 1,
        "role": "cover",
        "collision": "box",
        "density": 1,
        "preview": "assets/v2/arcade/catalog/barrel.png",
        "label": "Barrel"
      },
      {
        "id": "rocks",
        "model": "assets/v2/arcade/arcade-rocks.glb",
        "metres": 2.5005,
        "role": "cover",
        "collision": "box",
        "density": 0.7,
        "preview": "assets/v2/arcade/catalog/rocks.png",
        "label": "Rocks"
      },
      {
        "id": "fence",
        "label": "Fence",
        "model": "assets/v2/arcade/arcade-fence.glb",
        "metres": 2.46,
        "role": "cover",
        "collision": "box",
        "density": 0.5,
        "preview": "assets/v2/arcade/catalog/fence.png"
      },
      {
        "id": "hayBarricade",
        "label": "Hay barricade",
        "model": "assets/v2/arcade/arcade-barricade.glb",
        "metres": 3.2993,
        "role": "barricade",
        "collision": "box",
        "density": 0.5,
        "preview": "assets/v2/arcade/catalog/barricade.png"
      },
      {
        "id": "crystalShrine",
        "label": "Crystal shrine",
        "model": "assets/v2/arcade/arcade-shrine.glb",
        "metres": 2.58,
        "role": "objective",
        "collision": "circle",
        "density": 0.1,
        "preview": "assets/v2/arcade/catalog/shrine.png"
      },
      {
        "id": "house",
        "label": "Village house",
        "model": "assets/v2/arcade/arcade-house-parts.glb",
        "metres": 10,
        "role": "dressing",
        "collision": "box",
        "generator": "house",
        "preview": "assets/v2/arcade/catalog/house.png"
      },
      {
        "id": "nature",
        "label": "Meadow flora",
        "model": "assets/v2/arcade/arcade-nature-parts.glb",
        "metres": 1.6,
        "role": "dressing",
        "collision": "none",
        "generator": "nature",
        "preview": "assets/v2/arcade/catalog/nature.png"
      },
      {
        "id": "tree",
        "label": "Village tree",
        "model": "assets/v2/arcade/arcade-tree-parts.glb",
        "metres": 6.5,
        "role": "dressing",
        "collision": "none",
        "generator": "tree",
        "preview": "assets/v2/arcade/catalog/tree.png"
      },
      {
        "id": "landmark",
        "label": "Village landmark",
        "model": "assets/v2/arcade/arcade-landmark-parts.glb",
        "metres": 9.0,
        "role": "dressing",
        "collision": "none",
        "generator": "landmark",
        "preview": "assets/v2/arcade/catalog/landmark.png"
      },
      {
        "id": "ammoSupply",
        "label": "Pebble pouch",
        "model": "assets/v2/arcade/arcade-pouch.glb",
        "metres": 0.5584,
        "role": "dressing",
        "collision": "none",
        "pickup": "ammo",
        "preview": "assets/v2/arcade/catalog/pouch.png"
      },
      {
        "id": "healthSupply",
        "label": "Honey jar",
        "model": "assets/v2/arcade/arcade-honey.glb",
        "metres": 0.336,
        "role": "dressing",
        "collision": "none",
        "pickup": "health",
        "preview": "assets/v2/arcade/catalog/honey.png"
      },
      {
        "id": "grenadeSupply",
        "label": "Fizz-bomb",
        "model": "assets/v2/arcade/arcade-fizzbomb.glb",
        "metres": 0.367,
        "role": "dressing",
        "collision": "none",
        "pickup": "grenade",
        "preview": "assets/v2/arcade/catalog/fizzbomb.png"
      }
    ],
    "gear": [
      {
        "id": "keyAmber",
        "label": "Amber key",
        "model": "assets/v2/arcade/arcade-keys.glb",
        "node": "Key_amber",
        "metres": 0.443,
        "role": "gear",
        "collision": "none",
        "preview": "assets/v2/arcade/catalog/key.png"
      },
      {
        "id": "keyIce",
        "label": "Ice key",
        "model": "assets/v2/arcade/arcade-keys.glb",
        "node": "Key_ice",
        "metres": 0.443,
        "role": "gear",
        "collision": "none",
        "preview": "assets/v2/arcade/catalog/key.png"
      },
      {
        "id": "keyRose",
        "label": "Rose key",
        "model": "assets/v2/arcade/arcade-keys.glb",
        "node": "Key_rose",
        "metres": 0.443,
        "role": "gear",
        "collision": "none",
        "preview": "assets/v2/arcade/catalog/key.png"
      },
      {
        "id": "lockAmber",
        "label": "Amber padlock",
        "model": "assets/v2/arcade/arcade-locks.glb",
        "node": "Lock_amber",
        "metres": 0.296,
        "role": "gear",
        "collision": "none",
        "preview": "assets/v2/arcade/catalog/lock.png"
      },
      {
        "id": "lockIce",
        "label": "Ice padlock",
        "model": "assets/v2/arcade/arcade-locks.glb",
        "node": "Lock_ice",
        "metres": 0.296,
        "role": "gear",
        "collision": "none",
        "preview": "assets/v2/arcade/catalog/lock.png"
      },
      {
        "id": "lockRose",
        "label": "Rose padlock",
        "model": "assets/v2/arcade/arcade-locks.glb",
        "node": "Lock_rose",
        "metres": 0.296,
        "role": "gear",
        "collision": "none",
        "preview": "assets/v2/arcade/catalog/lock.png"
      },
      {
        "id": "lever",
        "label": "Lever",
        "model": "assets/v2/arcade/arcade-lever.glb",
        "metres": 0.968,
        "role": "gear",
        "collision": "circle",
        "preview": "assets/v2/arcade/catalog/lever.png"
      },
      {
        "id": "honeyDrop",
        "label": "Honey drop",
        "model": "assets/v2/arcade/arcade-drop.glb",
        "metres": 0.55,
        "role": "gear",
        "collision": "none",
        "preview": "assets/v2/arcade/catalog/drop.png"
      },
      {
        "id": "staff",
        "label": "Trail staff",
        "model": "assets/v2/arcade/arcade-staff.glb",
        "metres": 1.206,
        "role": "gear",
        "collision": "none",
        "preview": "assets/v2/arcade/catalog/staff.png"
      }
    ],
    "biomes": {
      "desert": {
        "label": "Desert oasis",
        "props": {
          "rocks": {
            "label": "Rocks",
            "preview": "assets/v2/arcade/catalog/desert-rocks.png"
          },
          "fence": {
            "label": "Low wall",
            "preview": "assets/v2/arcade/catalog/desert-wall.png"
          },
          "hayBarricade": {
            "label": "Crate barricade",
            "preview": "assets/v2/arcade/catalog/desert-barricade.png"
          },
          "house": {
            "label": "Desert house",
            "preview": "assets/v2/arcade/catalog/desert-house.png"
          },
          "nature": {
            "label": "Desert flora",
            "preview": "assets/v2/arcade/catalog/desert-nature.png"
          },
          "tree": {
            "label": "Palm or cactus",
            "preview": "assets/v2/arcade/catalog/desert-tree.png"
          },
          "landmark": {
            "label": "Oasis landmark",
            "preview": "assets/v2/arcade/catalog/desert-landmark.png"
          }
        }
      },
      "snow": {
        "label": "Snow village",
        "props": {
          "rocks": {
            "label": "Rocks",
            "preview": "assets/v2/arcade/catalog/snow-rocks.png"
          },
          "barrel": {
            "label": "Snowy barrel",
            "preview": "assets/v2/arcade/catalog/snow-barrel.png"
          },
          "fence": {
            "label": "Split-rail fence",
            "preview": "assets/v2/arcade/catalog/snow-fence.png"
          },
          "hayBarricade": {
            "label": "Sled barricade",
            "preview": "assets/v2/arcade/catalog/snow-barricade.png"
          },
          "house": {
            "label": "Alpine house",
            "preview": "assets/v2/arcade/catalog/snow-house.png"
          },
          "nature": {
            "label": "Winter flora",
            "preview": "assets/v2/arcade/catalog/snow-nature.png"
          },
          "tree": {
            "label": "Snowy tree",
            "preview": "assets/v2/arcade/catalog/snow-tree.png"
          },
          "landmark": {
            "label": "Bell tower",
            "preview": "assets/v2/arcade/catalog/snow-landmark.png"
          }
        }
      }
    },
    "measurements": {
      "assets/v2/arcade/arcade-keys.glb": {
        "longest": 0.443,
        "size": [
          0.22,
          0.443,
          0.1479
        ],
        "revision": "c0894c6d3fa9"
      },
      "assets/v2/arcade/arcade-locks.glb": {
        "longest": 0.296,
        "size": [
          0.2,
          0.296,
          0.118
        ],
        "revision": "bcb09e39cf4f"
      },
      "assets/v2/arcade/arcade-lever.glb": {
        "longest": 0.968,
        "size": [
          0.5,
          0.968,
          0.4
        ],
        "revision": "cdf9bcdcb5dc"
      },
      "assets/v2/arcade/arcade-drop.glb": {
        "longest": 0.3339,
        "size": [
          0.256,
          0.3339,
          0.256
        ],
        "revision": "324ad02b6219"
      },
      "assets/v2/arcade/arcade-staff.glb": {
        "longest": 1.2056,
        "size": [
          0.1999,
          0.124,
          1.2056
        ],
        "revision": "c060ae283524"
      },
      "assets/v2/arcade/characters/arcade-hero.glb": {
        "longest": 2.0806,
        "size": [
          1.791,
          2.0806,
          0.7143
        ],
        "revision": "7dd45daf9161"
      },
      "assets/v2/arcade/arcade-creature-parts.glb": {
        "longest": 1.4256,
        "size": [
          1.4256,
          1.2684,
          1.4201
        ],
        "revision": "b9c65a21d885"
      },
      "assets/v2/arcade/arcade-nature-parts.glb": {
        "revision": "17a281ce0479"
      },
      "assets/v2/arcade/arcade-landmark-parts.glb": {
        "revision": "624d050c76e2"
      },
      "assets/v2/arcade/arcade-slingshot.glb": {
        "longest": 0.3037,
        "size": [
          0.177,
          0.3037,
          0.1984
        ],
        "revision": "1bf74e579f16"
      },
      "assets/v2/arcade/arcade-repeater.glb": {
        "longest": 0.708,
        "size": [
          0.547,
          0.304,
          0.708
        ],
        "revision": "51cb521e0163"
      },
      "assets/v2/arcade/arcade-blunderbuss.glb": {
        "longest": 1.046,
        "size": [
          0.152,
          0.252,
          1.046
        ],
        "revision": "f2b51e420e71"
      },
      "assets/v2/arcade/arcade-arbalest.glb": {
        "longest": 1.068,
        "size": [
          0.732,
          0.265,
          1.068
        ],
        "revision": "2b7031ca9b5f"
      },
      "assets/v2/arcade/arcade-cannon.glb": {
        "longest": 0.666,
        "size": [
          0.176,
          0.382,
          0.666
        ],
        "revision": "234b63a0897b"
      },
      "assets/v2/arcade/arcade-barrel.glb": {
        "longest": 1,
        "size": [
          0.906,
          1,
          0.906
        ],
        "revision": "948b9d75175a"
      },
      "assets/v2/arcade/arcade-rocks.glb": {
        "longest": 2.5005,
        "size": [
          2.5005,
          0.9583,
          1.994
        ],
        "revision": "d4cb406eeae9"
      },
      "assets/v2/arcade/arcade-fence.glb": {
        "longest": 2.46,
        "size": [
          2.46,
          1.399,
          0.36
        ],
        "revision": "f303605a465c"
      },
      "assets/v2/arcade/arcade-barricade.glb": {
        "longest": 3.2993,
        "size": [
          3.2993,
          1.16,
          1.0951
        ],
        "revision": "419986ba4c17"
      },
      "assets/v2/arcade/arcade-gate.glb": {
        "longest": 4.45,
        "size": [
          4.45,
          3.375,
          0.9726
        ],
        "revision": "366f51e3e4dd"
      },
      "assets/v2/arcade/arcade-shrine.glb": {
        "longest": 2.58,
        "size": [
          1.9192,
          2.58,
          1.9192
        ],
        "revision": "60f4941d2aa7"
      },
      "assets/v2/arcade/arcade-house-parts.glb": {
        "longest": 3.53,
        "size": [
          2.28,
          3.22,
          3.53
        ],
        "revision": "9eaf37a35c83"
      },
      "assets/v2/arcade/arcade-desert-parts.glb": {
        "longest": 12.815,
        "size": [
          5.17,
          12.815,
          5.6898
        ],
        "revision": "182b722882ee"
      },
      "assets/v2/arcade/arcade-desert-rocks.glb": {
        "longest": 2.4998,
        "size": [
          2.4998,
          1.4325,
          1.2666
        ],
        "revision": "d8cf1230091c"
      },
      "assets/v2/arcade/arcade-desert-wall.glb": {
        "longest": 2.46,
        "size": [
          2.46,
          1.215,
          0.46
        ],
        "revision": "43735714b437"
      },
      "assets/v2/arcade/arcade-desert-barricade.glb": {
        "longest": 3.3069,
        "size": [
          3.3069,
          1.22,
          1.095
        ],
        "revision": "c2cfc386dacf"
      },
      "assets/v2/arcade/arcade-snow-parts.glb": {
        "longest": 13.4566,
        "size": [
          4.2498,
          13.4566,
          5.13
        ],
        "revision": "7b9f9cab79a1"
      },
      "assets/v2/arcade/arcade-snow-rocks.glb": {
        "longest": 2.5084,
        "size": [
          2.5084,
          1.5139,
          1.6821
        ],
        "revision": "273ba82bf163"
      },
      "assets/v2/arcade/arcade-snow-fence.glb": {
        "longest": 2.4684,
        "size": [
          2.4684,
          1.2492,
          0.3144
        ],
        "revision": "835702158ee2"
      },
      "assets/v2/arcade/arcade-snow-barricade.glb": {
        "longest": 3.5119,
        "size": [
          3.5119,
          1.3649,
          1.0507
        ],
        "revision": "4375dfd85340"
      },
      "assets/v2/arcade/arcade-snow-barrel.glb": {
        "longest": 1,
        "size": [
          0.916,
          1,
          0.893
        ],
        "revision": "d0d4a6636732"
      },
      "assets/v2/arcade/arcade-pouch.glb": {
        "longest": 0.5584,
        "size": [
          0.41,
          0.5584,
          0.4181
        ],
        "revision": "0209e14bf43d"
      },
      "assets/v2/arcade/arcade-honey.glb": {
        "longest": 0.336,
        "size": [
          0.326,
          0.336,
          0.3329
        ],
        "revision": "a0461190bb11"
      },
      "assets/v2/arcade/arcade-fizzbomb.glb": {
        "longest": 0.367,
        "size": [
          0.316,
          0.367,
          0.316
        ],
        "revision": "79a2b23a4768"
      },
      "assets/v2/arcade/arcade-ground.glb": {
        "longest": 17.682,
        "size": [
          17.6505,
          0.4788,
          17.682
        ],
        "revision": "782e6c751b1e"
      }
    }
  }
};
